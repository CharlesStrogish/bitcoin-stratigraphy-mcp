import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { canonical } from "../../src/lib/article12-signature";
import { createMemoryEnterpriseEconomicsStore } from "../../src/lib/enterprise-economics-store";
import {
  EnterpriseEconomics,
  EXEMPTION_SECONDS,
  enterpriseContext,
  enterpriseChallengeScope,
  type EnterpriseContext,
} from "../../src/lib/enterprise-economics";
import {
  createEnterpriseEconomicsMiddleware,
  parseAgentPayout,
} from "../../src/middleware/enterprise-economics";
import { registerCryptographicAuditRoutes } from "../../src/routes/cryptographic-audit";
import {
  createSubscriptionMacaroon,
  inspectSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../../src/lib/subscription-pass";
import type { SettlementRouter } from "../../src/services/settlement";

const keys = generateKeyPairSync("ed25519");
const buyer = "ab".repeat(32);
const now = Date.parse("2026-10-24T00:00:00.000Z");
const thresholdMsats = 250_000_000_000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function setup(price: number | null = 10_000_000) {
  let clock = now;
  const store = createMemoryEnterpriseEconomicsStore();
  const service = new EnterpriseEconomics(
    store,
    async () => price,
    () => keys.privateKey,
    () => clock,
  );
  const context = (): EnterpriseContext => ({
    buyer,
    payout: "agent@example.com",
    invoices: new Map(),
    now: () => clock,
  });
  return {
    service,
    store,
    context,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
function signed(payload: Record<string, unknown>, domain: string): boolean {
  const { issuer_attestation, ...unsigned } = payload;
  const attestation = issuer_attestation as { signature: string };
  return verify(
    null,
    Buffer.from(domain + canonical(unsigned)),
    keys.publicKey,
    Buffer.from(attestation.signature, "base64"),
  );
}

test("5% kickback is invoice-bound, signed, integer-msat rounded and payable only after settlement", async () => {
  const { service, store, context } = setup();
  const invoice = await service.issue(
    { paymentHash: hash("kickback"), provider: "test" },
    101_001,
    context(),
  );
  assert.equal(invoice.kickback_msats, "5050");
  assert.ok(
    signed(invoice.allocation, "bitcoin-stratigraphy/routing-kickback/v1\n"),
  );
  assert.equal(invoice.settled_at, undefined);
  assert.equal((await service.status(buyer)).total_msats, "0");
  await assert.rejects(
    service.settle(invoice.hash, 100_000, "test"),
    /does not match/,
  );
  await assert.rejects(
    service.settle(invoice.hash, 101_001, "other"),
    /does not match/,
  );
  await service.settle(invoice.hash, 101_001, "test");
  const saved = await store.transaction("read", (tx) =>
    tx.invoice(invoice.hash),
  );
  assert.equal(saved?.settled_at, new Date(now).toISOString());
  assert.equal(saved?.kickback_msats, "5050");
  assert.equal((await service.status(buyer)).total_msats, "101001");
  const replay = await service.issue(
    { paymentHash: invoice.hash, provider: "test" },
    101_001,
    context(),
  );
  assert.deepEqual(replay.allocation, invoice.allocation);
  await assert.rejects(
    service.issue({ paymentHash: invoice.hash, provider: "test" }, 101_001, {
      ...context(),
      payout: "thief@example.com",
    }),
    /already bound/,
  );
});

test("concurrent repeated settlement credits one invoice once and grants an exact signed 365-day expiry", async () => {
  const { service, context } = setup();
  const invoice = await service.issue(
    { paymentHash: hash("threshold"), provider: "test" },
    thresholdMsats,
    context(),
  );
  assert.equal(service.token(await service.status(buyer)), undefined);
  await Promise.all(
    Array.from({ length: 20 }, () =>
      service.settle(invoice.hash, thresholdMsats, "test"),
    ),
  );
  const account = await service.status(buyer);
  assert.equal(account.total_msats, String(thresholdMsats));
  assert.equal(account.qualifying_msats, "0");
  const token = service.token(account)!;
  assert.equal(Number(token.exp) - Number(token.iat), EXEMPTION_SECONDS);
  assert.equal(token.expiry_date, "2027-10-24T00:00:00.000Z");
  assert.equal(token.sub, buyer);
  assert.ok(signed(token, "bitcoin-stratigraphy/commercial-exemption/v1\n"));
  assert.equal(
    signed(
      { ...token, exp: Number(token.exp) + 1 },
      "bitcoin-stratigraphy/commercial-exemption/v1\n",
    ),
    false,
  );
});

test("expiry drops exemption, old spend/replayed proofs cannot renew, and new funded volume can renew", async () => {
  const { service, context, advance } = setup();
  const first = hash("annual-first");
  await service.issue(
    { paymentHash: first, provider: "test" },
    thresholdMsats,
    context(),
  );
  await service.settle(first, thresholdMsats, "test");
  advance(EXEMPTION_SECONDS * 1_000);
  const expired = await service.status(buyer);
  assert.equal(service.token(expired), undefined);
  assert.equal(
    service.describe({ ...context(), account: expired })
      .commercial_exemption_status,
    "Expired",
  );
  const expiredMacaroon = enterpriseContext.run(
    { ...context(), account: expired },
    () =>
      createSubscriptionMacaroon({
        secret: "expiry-test",
        paymentHash: first,
        tier: "1-day",
        validUntil: expired.grant!.exp + 100,
        amountMsats: 1000,
      }),
  );
  assert.ok(
    !JSON.parse(
      Buffer.from(expiredMacaroon, "base64url").toString(),
    ).caveats.includes("Commercial-Exemption: Active"),
  );
  assert.ok(inspectSubscriptionMacaroon(expiredMacaroon, "expiry-test"));
  await service.settle(first, thresholdMsats, "test");
  assert.equal(service.token(await service.status(buyer)), undefined);
  const second = hash("annual-second");
  await service.issue(
    { paymentHash: second, provider: "test" },
    thresholdMsats,
    context(),
  );
  const renewed = await service.settle(second, thresholdMsats, "test");
  assert.equal(service.token(renewed)?.expiry_date, "2028-10-23T00:00:00.000Z");
});

test("new confirmed volume can reserve next-year renewal, but unfunded requests and missing FX cannot grant", async () => {
  const { service, context, advance } = setup();
  for (const id of ["funded", "reserved"]) {
    await service.issue(
      { paymentHash: hash(id), provider: "test" },
      thresholdMsats,
      context(),
    );
    await service.settle(hash(id), thresholdMsats, "test");
  }
  assert.equal(
    (await service.status(buyer)).qualifying_msats,
    String(thresholdMsats),
  );
  advance(EXEMPTION_SECONDS * 1_000);
  assert.equal(
    service.token(await service.status(buyer))?.expiry_date,
    "2028-10-23T00:00:00.000Z",
  );
  const unavailable = setup(null);
  await unavailable.service.issue(
    { paymentHash: hash("no-fx"), provider: "test" },
    thresholdMsats,
    unavailable.context(),
  );
  await unavailable.service.settle(hash("no-fx"), thresholdMsats, "test");
  assert.equal(
    unavailable.service.token(await unavailable.service.status(buyer)),
    undefined,
  );
  assert.equal(
    (await unavailable.service.status(buyer)).total_msats,
    String(thresholdMsats),
  );
});

test("enterprise caveats are issuer-only, buyer-authenticated, expiry-clamped and cannot be forged by holder HMAC attenuation", async () => {
  const { service, context } = setup();
  const paymentHash = hash("macaroon");
  const ctx = context();
  await service.issue({ paymentHash, provider: "test" }, thresholdMsats, ctx);
  ctx.account = await service.settle(paymentHash, thresholdMsats, "test");
  const options = {
    secret: "test-secret",
    paymentHash,
    tier: "1-day" as const,
    validUntil: Math.floor(now / 1_000) + EXEMPTION_SECONDS * 2,
    amountMsats: thresholdMsats,
  };
  const encoded = enterpriseContext.run(ctx, () =>
    createSubscriptionMacaroon(options),
  );
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString());
  assert.ok(decoded.caveats.includes("Commercial-Exemption: Active"));
  assert.ok(
    decoded.caveats.some((c: string) => c.startsWith("routing_kickback=")),
  );
  const inspection = inspectSubscriptionMacaroon(encoded, options.secret)!;
  assert.equal(inspection.agentId, buyer);
  assert.equal(inspection.agentAuthentication, "nip98");
  assert.equal(
    inspection.validUntil,
    Math.floor(now / 1_000) + EXEMPTION_SECONDS,
  );
  assert.equal(
    verifySubscriptionMacaroon(encoded, options.secret, inspection.validUntil),
    null,
  );
  const unlicensed = createSubscriptionMacaroon(options);
  const forged = JSON.parse(Buffer.from(unlicensed, "base64url").toString());
  for (const caveat of [
    "Commercial-Exemption: Active",
    `commercial_exemption_exp=${inspection.validUntil}`,
  ]) {
    forged.caveats.push(caveat);
    forged.signature = createHmac(
      "sha256",
      Buffer.from(forged.signature, "hex"),
    )
      .update(caveat)
      .digest("hex");
  }
  assert.equal(
    inspectSubscriptionMacaroon(
      Buffer.from(JSON.stringify(forged)).toString("base64url"),
      options.secret,
    ),
    null,
  );
  assert.notEqual(
    enterpriseContext.run(ctx, enterpriseChallengeScope),
    enterpriseContext.run(
      { ...ctx, payout: "other@example.com" },
      enterpriseChallengeScope,
    ),
  );
  assert.notEqual(
    enterpriseContext.run(ctx, enterpriseChallengeScope),
    enterpriseContext.run(
      { ...ctx, account: undefined },
      enterpriseChallengeScope,
    ),
    "Activating a license must not reissue different quota-bearing roots for a cached old invoice",
  );
});

test("settlement wrapper ignores invalid proofs and non-BTC rails; original buyer receives credit, never a new caller", async () => {
  const { service, context } = setup();
  let result: Awaited<ReturnType<SettlementRouter["verifyPayment"]>> =
    "invalid";
  const wrapped = service.wrap({
    isConfigured: () => true,
    activeProvider: () => "test",
    circuitState: () => "closed",
    createInvoice: async () => ({
      paymentHash: hash("wrapped"),
      provider: "test",
      invoice: "lnbc-test",
    }),
    verifyPayment: async () => result,
  });
  const input = {
    amountMsats: thresholdMsats,
    description: "test",
    expirySeconds: 3600,
    asset: "btc-lightning" as const,
  };
  const ctx = context();
  await enterpriseContext.run(ctx, () => wrapped.createInvoice(input));
  const proof = {
    paymentHash: hash("wrapped"),
    expectedAmountMsats: thresholdMsats,
    expectedDescription: "test",
    preimage: "00".repeat(32),
  };
  await wrapped.verifyPayment(proof);
  assert.equal((await service.status(buyer)).total_msats, "0");
  result = { provider: "test", settledAt: now, asset: "l-btc" };
  await wrapped.verifyPayment(proof);
  assert.equal((await service.status(buyer)).total_msats, "0");
  result = { provider: "test", settledAt: now, asset: "btc-lightning" };
  const other = { ...context(), buyer: "cd".repeat(32) };
  await enterpriseContext.run(other, () => wrapped.verifyPayment(proof));
  assert.equal(other.account, undefined);
  assert.equal((await service.status(other.buyer)).total_msats, "0");
  assert.equal(
    (await service.status(buyer)).total_msats,
    String(thresholdMsats),
  );
});

test("payout validation rejects conflicting addresses, malformed LNURLs and unsafe syntax", () => {
  assert.equal(parseAgentPayout("agent@EXAMPLE.COM"), "agent@example.com");
  assert.equal(parseAgentPayout(), undefined);
  for (const args of [
    ["a@example.com", "lnurl1invalid"],
    ["https://example.com"],
    [undefined, "lnurl1qqqqqq"],
    ["a@example.com\n"],
  ]) {
    assert.throws(() => parseAgentPayout(...(args as [string?, string?])));
  }
});

test("REST audit receipt hashes exact canonical decision/data, rejects invalid inputs and exposes authenticated annual expiry", async (t) => {
  const fixture = setup();
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const app = express();
  const licenseLogs: Record<string, unknown>[] = [];
  app.use((req, _res, next) => {
    (req as any).log = {
      info: (event: Record<string, unknown>) => licenseLogs.push(event),
      error() {},
    };
    next();
  });
  app.use(
    express.json({
      limit: "1mb",
      verify(req, _res, bytes) {
        (req as any).rawBody = bytes;
      },
    }),
  );
  app.use(createEnterpriseEconomicsMiddleware(fixture.service));
  app.get("/api/v1/cost", (_req, res) => {
    res.json({ total_sats: 1 });
  });
  app.post("/api/v1/cost", (_req, res) => {
    res.json({ total_sats: 1 });
  });
  const router: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "test",
    circuitState: () => "closed",
    createInvoice: async () => ({
      paymentHash: createHash("sha256").update(Buffer.alloc(32)).digest("hex"),
      provider: "test",
      invoice: "lnbc-test-purchase",
    }),
    verifyPayment: async () => ({
      provider: "test",
      settledAt: now,
      asset: "btc-lightning",
    }),
  };
  registerCryptographicAuditRoutes(app, fixture.service, {
    loadKey: () => keys.privateKey,
    router: fixture.service.wrap(router),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = (
    path: string,
    method: string,
    body?: string,
  ): Record<string, string> => {
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(now / 1_000),
        content: "",
        tags: [
          ["u", base + path],
          ["method", method],
          ...(body ? [["payload", hash(body)]] : []),
        ],
      },
      secretKey,
    );
    return {
      "X-Nostr-Authorization":
        "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64"),
      "Buyer-Pubkey": pubkey,
      "content-type": "application/json",
    };
  };
  const path = "/api/v1/compliance/indemnity";
  for (const method of ["GET", "POST"]) {
    const quote = await fetch(base + "/api/v1/cost", {
      method,
      headers: { "X-Agent-Lightning-Address": "agent@example.com" },
    });
    const quoted = await quote.json();
    assert.equal(quoted.enterprise_economics.routing_kickback_percent, 5);
    assert.equal(
      quoted.enterprise_economics.payout_mode,
      "ledger_only_no_automatic_disbursement",
    );
  }
  const input = {
    agent_decision: " execute with exact spaces ",
    stratigraphy_data_used: { height: 900000, state: { n: 1 } },
  };
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  const receipt = (await response.json()).indemnity_receipt;
  assert.equal(receipt.commitment_sha256, hash(canonical(input)));
  assert.ok(signed(receipt, "bitcoin-stratigraphy/cryptographic-audit/v1\n"));
  assert.equal(receipt.state_anchor_verified, false);
  assert.equal(receipt.agent_execution_proven, false);
  assert.equal(receipt.commercial_exemption_expiry_date, null);
  assert.equal(JSON.stringify(receipt).includes(input.agent_decision), false);
  for (const body of [
    {},
    { ...input, agent_decision: " " },
    { ...input, stratigraphy_data_used: [] },
    { ...input, extra: true },
  ]) {
    assert.equal(
      (
        await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          stratigraphy_data_used: { big: "x".repeat(140_000) },
        }),
      })
    ).status,
    413,
  );
  const statusPath = "/api/v1/compliance/commercial-exemption";
  assert.equal((await fetch(base + statusPath)).status, 401);
  assert.equal(
    (await fetch(base + statusPath, { headers: { "Buyer-Pubkey": pubkey } }))
      .status,
    401,
  );
  assert.equal(
    (
      await fetch(base + statusPath, {
        headers: { ...headers(statusPath, "GET"), "Buyer-Pubkey": buyer },
      })
    ).status,
    401,
  );
  const purchase = statusPath + "/purchase";
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "enterprise-route-test-secret";
  t.after(() => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  });
  const quote = await fetch(base + purchase, {
    method: "POST",
    headers: {
      ...headers(purchase, "POST"),
      "X-Agent-Lightning-Address": "affiliate@example.com",
    },
  });
  assert.equal(quote.status, 402);
  const challenge = await quote.json();
  assert.equal(
    challenge.enterprise_economics.commercial_exemption_status,
    "Inactive",
  );
  assert.equal(
    challenge.autonomous_routing_kickbacks[0].kickback_msats,
    "12500000000",
  );
  const paid = await fetch(base + purchase, {
    method: "POST",
    headers: {
      ...headers(purchase, "POST"),
      authorization: `L402 ${challenge.macaroon}:${"00".repeat(32)}`,
    },
  });
  assert.equal(paid.status, 200);
  const output = await paid.json();
  assert.equal(output.commercial_exemption_status, "Active");
  assert.equal(
    output.commercial_exemption_token.expiry_date,
    "2027-10-24T00:00:00.000Z",
  );
  assert.equal(
    paid.headers.get("X-Commercial-Exemption-Expires"),
    output.commercial_exemption_token.expiry_date,
  );
  const audited = await fetch(base + path, {
    method: "POST",
    headers: headers(path, "POST", JSON.stringify(input)),
    body: JSON.stringify(input),
  });
  assert.equal(
    (await audited.json()).indemnity_receipt.commercial_exemption_expiry_date,
    "2027-10-24T00:00:00.000Z",
  );
  fixture.advance(EXEMPTION_SECONDS * 1_000);
  const expiredHeaders = headers(statusPath, "GET");
  // The event helper signs the original clock; expiry must also require a fresh event.
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(now / 1_000) + EXEMPTION_SECONDS,
      content: "",
      tags: [
        ["u", base + statusPath],
        ["method", "GET"],
      ],
    },
    secretKey,
  );
  expiredHeaders["X-Nostr-Authorization"] =
    "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64");
  const expired = await fetch(base + statusPath, { headers: expiredHeaders });
  assert.equal((await expired.json()).commercial_exemption_status, "Expired");
  assert.equal(expired.headers.get("X-Commercial-Exemption-Token"), null);
  assert.ok(
    licenseLogs.some(
      (event) =>
        event.commercial_exemption_status === "Expired" &&
        event.copyleft_risk === "high",
    ),
  );
});
