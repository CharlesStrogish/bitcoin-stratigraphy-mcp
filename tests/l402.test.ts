import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createMemoryMacaroonRevocationStore } from "../artifacts/api-server/src/lib/macaroon-revocation-store";
import { L402EdgeCache } from "../artifacts/api-server/src/lib/l402-edge-cache";
import express from "express";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { createL402Middleware, parseL402Header } from "../artifacts/api-server/src/middleware/l402";
import {
  generateCryptographicAttestation,
  verifyCryptographicAttestation,
} from "../artifacts/api-server/src/services/attestation";
import {
  createSubscriptionMacaroon,
  attenuateSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../artifacts/api-server/src/lib/subscription-pass";
import type { SettlementRouter } from "../artifacts/api-server/src/services/settlement";
import { createMemoryRevenueLedger } from "../artifacts/api-server/src/services/ledger";
import { createNwcSettlementProvider } from "../artifacts/api-server/src/services/settlement/nwc-provider";

const PREIMAGE = "01".repeat(32);
const TEST_NOSTR_PRIVATE_KEY = "01".padStart(64, "0");
const TEST_NOSTR_PUBLIC_KEY = getPublicKey(
  Uint8Array.from(Buffer.from(TEST_NOSTR_PRIVATE_KEY, "hex")),
);
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex");

function fakeSettlementRouter(): SettlementRouter {
  let invoiceCount = 0;
  return {
    isConfigured: () => true,
    activeProvider: () => "test-wallet",
    circuitState: () => "closed",
    async createInvoice() {
      invoiceCount += 1;
      return {
        invoice: `lnbc5n1test${invoiceCount}`,
        paymentHash: PAYMENT_HASH,
        provider: "test-wallet",
      };
    },
    async verifyPayment(input) {
      return input.paymentHash === PAYMENT_HASH &&
        input.preimage === PREIMAGE &&
        input.expectedAmountMsats === 5_000 &&
        input.expectedDescription === "test paid route" &&
        input.expectedProvider === "test-wallet"
        ? { settledAt: 1_789_963_200, provider: "test-wallet" }
        : "invalid";
    },
  };
}

test("issues an L402 challenge and accepts a hash-bound settled preimage", async () => {
  const app = express();
  const ledger = createMemoryRevenueLedger();
  let dynamicAmountSats = 5;
  app.get(
    "/paid",
    createL402Middleware({
      amountSats: () => dynamicAmountSats,
      description: "test paid route",
      settlementRouter: fakeSettlementRouter(),
      sessionSecret: "test-session-secret",
      now: () => 1_789_963_200_000,
      ledger,
      requestKind: "stratigraphy",
      expectedOutputSchema: { type: "object", properties: { paid: { type: "boolean" } }, required: ["paid"] },
    }),
    (_req, res) => res.status(200).json({ paid: true }),
  );
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const challenge = await fetch(`${baseUrl}/paid`);
    assert.equal(challenge.status, 402);
    const authenticate = challenge.headers.get("www-authenticate");
    assert.ok(authenticate);
    const match = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(
      authenticate,
    );
    assert.ok(match);
    assert.match(match[2]!, /^lnbc/);
    const quoted = await challenge.json() as { amount_sats: number; staged_preview: {
      status: string; quoted_toll_sats: number; merkle_standard: string;
      expected_output_schema: { required: string[] }; agent_instruction: string;
    } };
    assert.equal(quoted.amount_sats, 5);
    assert.equal(quoted.staged_preview.status, "ENDPOINT_READY_AWAITING_L402_SETTLEMENT");
    assert.equal(quoted.staged_preview.quoted_toll_sats, 5);
    assert.equal(quoted.staged_preview.merkle_standard, "RFC 6962 SHA-256");
    assert.deepEqual(quoted.staged_preview.expected_output_schema.required, ["paid"]);
    assert.match(quoted.staged_preview.agent_instruction, /have not run/);
    const guidance = quoted as unknown as {
      agent_instruction: string;
      settlement_paths: Array<{ id: string; authorization: string }>;
      preflight: {
        genesis_receipt: {
          path: string;
          canonical_url: string;
          escrow_id: string;
          settled_at_strata_block: number;
          toll_fee_sats: number;
        };
      };
    };
    assert.deepEqual(
      guidance.settlement_paths.map(({ id, authorization }) => ({ id, authorization })),
      [
        { id: "sha256_preimage", authorization: "Authorization: L402 <macaroon>:<preimage>" },
        { id: "nwc_lookup", authorization: "Authorization: L402 <macaroon>:NWC_LOOKUP" },
      ],
    );
    assert.match(guidance.agent_instruction, /<macaroon>:<preimage>/);
    assert.match(guidance.agent_instruction, /<macaroon>:NWC_LOOKUP/);
    assert.match(guidance.agent_instruction, /409/);
    assert.equal(guidance.preflight.genesis_receipt.path, "/api/v1/escrow/genesis-receipt");
    assert.equal(
      guidance.preflight.genesis_receipt.canonical_url,
      "https://bitcoinstratigraphy.com/api/v1/escrow/genesis-receipt",
    );
    assert.equal(guidance.preflight.genesis_receipt.escrow_id, "ba4f25dd-7f16-420c-9264-a16f102fd5a6");
    assert.equal(guidance.preflight.genesis_receipt.settled_at_strata_block, 971341);
    assert.equal(guidance.preflight.genesis_receipt.toll_fee_sats, 24);

    dynamicAmountSats = 9;
    const paid = await fetch(`${baseUrl}/paid`, {
      headers: { Authorization: `L402 ${match[1]}:${PREIMAGE}` },
    });
    assert.equal(paid.status, 200);
    assert.deepEqual(await paid.json(), { paid: true });
    assert.equal(await ledger.getTotalVolume(), 5);

    const replay = await fetch(`${baseUrl}/paid`, {
      headers: { Authorization: `L402 ${match[1]}:${PREIMAGE}` },
    });
    assert.equal(replay.status, 429);
    assert.equal(await ledger.getTotalVolume(), 5);

    const wrongPreimage = await fetch(`${baseUrl}/paid`, {
      headers: { Authorization: `L402 ${match[1]}:${"02".repeat(32)}` },
    });
    assert.equal(wrongPreimage.status, 402);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("a 25000-sat 100-call macro depletes atomically using one invoice and one wallet verification", async () => {
  let invoiceCount = 0;
  let verificationCount = 0;
  const revocationStore = createMemoryMacaroonRevocationStore();
  let clock = 1_789_963_200_000;
  const app = express();
  const provider: SettlementRouter = {
    ...fakeSettlementRouter(),
    async createInvoice(input) {
      invoiceCount++;
      assert.equal(input.amountMsats, 25_000_000);
      assert.equal(input.description, "test paid route (100-call batch)");
      return {
        invoice: "lnbc5n1batch",
        paymentHash: PAYMENT_HASH,
        provider: "test-wallet",
      };
    },
    async verifyPayment(input) {
      verificationCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(input.expectedAmountMsats, 25_000_000);
      assert.equal(
        input.expectedDescription,
        "test paid route (100-call batch)",
      );
      return input.preimage === PREIMAGE
        ? { settledAt: clock, provider: "test-wallet" }
        : "invalid";
    },
  };
  app.get(
    "/batch",
    createL402Middleware({
      amountSats: 250,
      description: "test paid route",
      settlementRouter: provider,
      sessionSecret: "test-macro-secret",
      allowBatch: true,
      now: () => clock,
      revocationStore,
    }),
    (_req, res) => res.json({ paid: true }),
  );
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/batch`;
  try {
    const invalid = await fetch(url, {
      headers: { "X-L402-Batch-Size": "101" },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invoiceCount, 0);
    const challenge = await fetch(url, {
      headers: { "X-L402-Batch-Size": "100" },
    });
    assert.equal(challenge.status, 402);
    const offer = (await challenge.json()) as {
      macaroon: string;
      max_requests: number;
      amount_sats: number;
    };
    assert.equal(offer.max_requests, 100);
    assert.equal(offer.amount_sats, 25_000);
    const pass = verifySubscriptionMacaroon(
      offer.macaroon,
      "test-macro-secret",
      Math.floor(clock / 1_000),
    );
    assert.equal(pass?.maxRequests, 100);
    assert.ok(pass);
    assert.deepEqual(pass?.allowedPaths, ["/batch"]);
    const headers = { Authorization: `L402 ${offer.macaroon}:${PREIMAGE}` };
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => fetch(url, { headers })),
    );
    for (const response of responses) {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    const exhausted = await fetch(url, { headers });
    assert.equal(exhausted.status, 429);
    assert.equal(exhausted.headers.get("www-authenticate"), null);
    assert.equal(invoiceCount, 1);
    assert.equal(verificationCount, 1);
    const child = attenuateSubscriptionMacaroon(offer.macaroon, [
      `time_before=${new Date(clock + 20).toISOString()}`,
      "max_requests=1",
    ]);
    assert.ok(child);
    const childHeaders = {
      Authorization: `L402 ${child}:${PREIMAGE}`,
      "X-L402-Batch-Size": "100",
    };
    assert.equal((await fetch(url, { headers: childHeaders })).status, 429);
    clock += 21;
    assert.equal(
      (await fetch(url, { headers: childHeaders })).status,
      401,
      "cached descendant deadlines cannot outlive time_before",
    );
    assert.equal(
      verificationCount,
      1,
      "descendants reuse the exact invoice proof without resetting its quota",
    );
    assert.equal(invoiceCount, 1);
    await revocationStore.revoke(pass.tokenId);
    const revoked = await fetch(url, { headers });
    assert.equal(revoked.status, 401);
    assert.equal(invoiceCount, 1);
    assert.equal(verificationCount, 1);
    clock += 3_600_000;
    const expired = await fetch(url, {
      headers: { ...headers, "X-L402-Batch-Size": "100" },
    });
    assert.equal(expired.status, 402);
    assert.equal(invoiceCount, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("edge cache is bounded, expires entries, coalesces lookups, and never caches failed verification", async () => {
  let clock = 0;
  const cache = new L402EdgeCache<string>(() => clock, 2);
  let lookups = 0;
  const load = async () => {
    lookups++;
    await Promise.resolve();
    return "settled";
  };
  const values = await Promise.all(
    Array.from({ length: 10 }, () =>
      cache.resolve("credential", 100, load, (value) => value === "settled"),
    ),
  );
  assert.deepEqual(values, Array(10).fill("settled"));
  assert.equal(lookups, 1);
  cache.set("other", "settled", 100);
  cache.set("third", "settled", 100);
  assert.equal(cache.get("credential"), undefined);
  clock = 100;
  assert.equal(cache.get("third"), undefined);
  for (let attempt = 0; attempt < 2; attempt++) {
    await cache.resolve(
      "pending",
      200,
      async () => {
        lookups++;
        return "invalid";
      },
      (value) => value === "settled",
    );
  }
  assert.equal(lookups, 3);
  assert.equal(cache.get("pending"), undefined);
});

test("verifies signed cryptographic attestations and rejects tampering", () => {
  const attestation = generateCryptographicAttestation(
    { height: 900_000, telemetry: ["alpha", "beta"] },
    {
      privateKey: TEST_NOSTR_PRIVATE_KEY,
      timestamp: 1_789_963_200_000,
    },
  );
  assert.equal(
    verifyCryptographicAttestation(attestation, {
      issuerPublicKey: TEST_NOSTR_PUBLIC_KEY,
    }),
    true,
  );
  assert.equal(
    verifyCryptographicAttestation(
      {
        ...attestation,
        payload: { height: 900_001, telemetry: ["alpha", "beta"] },
      },
      { issuerPublicKey: TEST_NOSTR_PUBLIC_KEY },
    ),
    false,
  );
  const attackerAttestation = generateCryptographicAttestation(
    { height: 900_000 },
    {
      privateKey: "02".padStart(64, "0"),
      timestamp: 1_789_963_200_000,
    },
  );
  assert.equal(
    verifyCryptographicAttestation(attackerAttestation, {
      issuerPublicKey: TEST_NOSTR_PUBLIC_KEY,
    }),
    false,
  );
});

test("rejects a paid but path-unbound macaroon on a fixed-fee route", async () => {
  const app = express();
  const macaroon = createSubscriptionMacaroon({
    secret: "test-session-secret",
    paymentHash: PAYMENT_HASH,
    tier: "1-day",
    validUntil: 1_789_963_300,
    amountMsats: 5_000,
    paymentAsset: "btc-lightning",
    paymentProvider: "test-wallet",
  });
  app.get(
    "/paid",
    createL402Middleware({
      amountSats: 5,
      description: "test paid route",
      settlementRouter: fakeSettlementRouter(),
      sessionSecret: "test-session-secret",
      now: () => 1_789_963_200_000,
    }),
    (_req, res) => res.status(200).end(),
  );
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/paid`, {
      headers: { Authorization: `L402 ${macaroon}:${PREIMAGE}` },
    });
    assert.equal(response.status, 402);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("rejects malformed attestation events without throwing", () => {
  const attestation = generateCryptographicAttestation(
    { height: 900_000 },
    {
      privateKey: TEST_NOSTR_PRIVATE_KEY,
      timestamp: 1_789_963_200_000,
    },
  );
  assert.doesNotThrow(() => {
    assert.equal(
      verifyCryptographicAttestation(
        {
          ...attestation,
          signature: {
            ...attestation.signature,
            event: null,
          },
        },
        { issuerPublicKey: TEST_NOSTR_PUBLIC_KEY },
      ),
      false,
    );
  });
});

test("rejects a valid signature carrying ambiguous attestation tags", () => {
  const attestation = generateCryptographicAttestation(
    { height: 900_000 },
    {
      privateKey: TEST_NOSTR_PRIVATE_KEY,
      timestamp: 1_789_963_200_000,
    },
  );
  const event = finalizeEvent(
    {
      kind: attestation.signature.event.kind,
      created_at: attestation.signature.event.created_at,
      content: attestation.signature.event.content,
      tags: [...attestation.signature.event.tags, ["x", "ff".repeat(32)]],
    },
    Uint8Array.from(Buffer.from(TEST_NOSTR_PRIVATE_KEY, "hex")),
  );
  assert.equal(
    verifyCryptographicAttestation(
      {
        ...attestation,
        signature: { ...attestation.signature, event },
      },
      { issuerPublicKey: TEST_NOSTR_PUBLIC_KEY },
    ),
    false,
  );
});

test("rejects non-canonical NWC proofs before wallet lookup", async () => {
  let clientCreations = 0;
  const provider = createNwcSettlementProvider({
    name: "test-wallet",
    uri: () => "nostr+walletconnect://configured",
    clientFactory: () => {
      clientCreations += 1;
      return {
        makeInvoice: async () => {
          throw new Error("unused");
        },
        lookupInvoice: async () => {
          throw new Error("must not be called");
        },
        close() {},
      } as never;
    },
  });
  assert.equal(
    await provider.verifyPayment({
      paymentHash: PAYMENT_HASH,
      preimage: "AB".repeat(32),
      expectedAmountMsats: 5_000,
      expectedDescription: "test paid route",
      asset: "btc-lightning",
    }),
    "invalid",
  );
  assert.equal(clientCreations, 0);
});

test("merchant lookup validates exact incoming invoice metadata and CoinOS credited amounts without payer access", async () => {
  const settledAt = Math.floor(Date.now() / 1000);
  const good = { type: "incoming", state: "settled", payment_hash: PAYMENT_HASH,
    amount: 5000, description: "test paid route", preimage: "consumer-reference",
    settled_at: settledAt, invoice: "ln-test-only" };
  let transaction = { ...good };
  let credit = { type: "incoming", state: "settled", amount: 5000,
    invoice: "ln-test-only", created_at: settledAt };
  let closes = 0;
  let listings = 0;
  const provider = createNwcSettlementProvider({
    name: "coinos", uri: () => "nostr+walletconnect://fixture-only",
    clientFactory: () => ({
      makeInvoice: async () => { throw new Error("unused"); },
      lookupInvoice: async () => transaction as never,
      listTransactions: async (request) => {
        assert.equal(request.type, "incoming"); listings++;
        return { transactions: [credit] } as never;
      },
      close: () => { closes++; },
    }),
  });
  const request = { paymentHash: PAYMENT_HASH, preimage: "NWC_LOOKUP",
    expectedAmountMsats: 5000, expectedDescription: good.description,
    expectedProvider: "coinos", asset: "btc-lightning" as const,
    verificationMode: "merchant-lookup" as const };
  for (const proof of ["", "NWC_LOOKUP", "11111111-1111-4111-8111-111111111111"]) {
    assert.deepEqual(await provider.verifyPayment({ ...request, preimage: proof }),
      { settledAt, provider: "coinos", asset: "btc-lightning" });
  }
  for (const alteration of [
    { state: "pending" }, { type: "outgoing" }, { amount: 4999 },
    { amount: 5001 }, { description: "different product" },
    { payment_hash: "f".repeat(64) }, { settled_at: 0 },
  ]) {
    transaction = { ...good, ...alteration };
    assert.equal(await provider.verifyPayment(request), "invalid");
  }
  transaction = { ...good, amount: 0 };
  assert.deepEqual(await provider.verifyPayment(request),
    { settledAt, provider: "coinos", asset: "btc-lightning" });
  credit = { ...credit, amount: 4999 };
  assert.equal(await provider.verifyPayment(request), "invalid");
  credit = { ...credit, amount: 5000, invoice: "ln-other" };
  assert.equal(await provider.verifyPayment(request), "invalid");
  assert.equal(await provider.verifyPayment({ ...request, expectedProvider: "alby" }), "invalid");
  assert.equal(await provider.verifyPayment({ ...request, asset: "l-btc" }), "invalid");
  assert.equal(await provider.verifyPayment({ ...request, preimage: "0".repeat(64) }), "invalid");
  assert.equal(closes, 13);
  assert.equal(listings, 3);
});

test("token-only, empty, NWC_LOOKUP and UUID retries preserve pending invoices and enforce single-use payment", async () => {
  for (const suffix of ["", ":", ":NWC_LOOKUP", ":11111111-1111-4111-8111-111111111111"]) {
    const app = express();
    const ledger = createMemoryRevenueLedger();
    let settled = false;
    let invoices = 0;
    let lookups = 0;
    const provider = createNwcSettlementProvider({
      name: "test-wallet", uri: () => "nostr+walletconnect://fixture-only",
      clientFactory: () => ({
        makeInvoice: async () => { throw new Error("unused"); },
        lookupInvoice: async (request) => {
          lookups++;
          assert.equal(request.payment_hash, PAYMENT_HASH);
          return { type: "incoming", state: settled ? "settled" : "pending",
            payment_hash: PAYMENT_HASH, amount: 5000, description: "test paid route",
            settled_at: Math.floor(Date.now() / 1000) } as never;
        },
        close() {},
      }),
    });
    const fake = fakeSettlementRouter();
    const router: SettlementRouter = { ...fake,
      createInvoice: async (input) => { invoices++; return fake.createInvoice(input); },
      verifyPayment: async (input) => {
        assert.equal(input.verificationMode, "merchant-lookup");
        return provider.verifyPayment(input);
      },
    };
    app.get("/paid", createL402Middleware({ amountSats: 5, description: "test paid route",
      settlementRouter: router, sessionSecret: "test-session", ledger }), (_req, res) => res.json({ paid: true }));
    const server = app.listen(0);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/paid`;
    try {
      const challenge = await fetch(url);
      const { macaroon } = await challenge.json() as { macaroon: string };
      assert.ok(parseL402Header(`L402 ${macaroon}${suffix}`));
      const headers = { Authorization: `L402 ${macaroon}${suffix}` };
      const pending = await fetch(url, { headers });
      assert.equal(pending.status, 409);
      assert.equal(invoices, 1);
      assert.equal(await ledger.getTotalVolume(), 0);
      settled = true;
      const paid = await fetch(url, { headers });
      assert.equal(paid.status, 200);
      assert.deepEqual(await paid.json(), { paid: true });
      assert.equal(await ledger.getTotalVolume(), 5);
      assert.equal((await fetch(url, { headers })).status, 429);
      assert.equal(lookups, 2);
      assert.equal(invoices, 1);
      assert.equal((await fetch(url + "-other", { headers })).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
