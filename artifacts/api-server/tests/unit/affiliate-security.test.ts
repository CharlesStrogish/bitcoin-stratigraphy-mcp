import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { createMemoryEnterpriseEconomicsStore } from "../../src/lib/enterprise-economics-store";
import {
  EnterpriseEconomics,
  enterpriseChallengeScope,
  enterpriseContext,
} from "../../src/lib/enterprise-economics";
import {
  affiliateBalance,
  verifyAffiliate,
  AFFILIATE_VERIFICATION_MS,
} from "../../src/lib/affiliate-security";
import {
  affiliateRecordUrl,
  createAffiliateProviderReader,
  providerOwnerKey,
} from "../../src/lib/affiliate-provider";
import { certifiedOracleStatus } from "../../src/lib/certified-oracle";
import { registerAffiliateRoutes } from "../../src/routes/affiliate";
import { registerOracleCrlRoutes } from "../../src/routes/oracle-crl";
import { registerCertifiedOracleRoutes } from "../../src/routes/certified-oracle";

const key = generateKeyPairSync("ed25519").privateKey;
const secret = generateSecretKey();
const pubkey = getPublicKey(secret);
const agent = "agent@example.com",
  parent = "parent@example.com";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const now = Date.parse("2026-10-24T00:00:00Z");
function setup() {
  let clock = now;
  const store = createMemoryEnterpriseEconomicsStore();
  const service = new EnterpriseEconomics(
    store,
    async () => 10_000_000,
    () => key,
    () => clock,
  );
  const provider = async () => ({
    version: 1,
    affiliates: {
      [agent]: { nostr_pubkey: pubkey },
      [parent]: { nostr_pubkey: pubkey },
    },
  });
  const issue = (id: string, amount = 10_000_000_000) =>
    service.issue({ paymentHash: hash(id), provider: "test" }, amount, {
      payout: agent,
      parentPayout: parent,
      invoices: new Map(),
    });
  return {
    store,
    service,
    provider,
    issue,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("21-cap rounding and pending/payable are separate from invoice settlement, independent per recipient", async () => {
  const { service, issue, provider, advance } = setup();
  const invoice = await issue("balance", 1_999);
  assert.equal(invoice.direct_kickback_msats, "279");
  assert.equal(invoice.parent_kickback_msats, "139");
  assert.equal(invoice.kickback_msats, "418");
  assert.equal((await affiliateBalance(service, agent)).payable_msats, "0");
  await service.settle(invoice.hash, 1_999, "test");
  assert.equal((await affiliateBalance(service, agent)).pending_msats, "279");
  assert.equal((await affiliateBalance(service, parent)).pending_msats, "139");
  await verifyAffiliate(service, agent, pubkey, hash("proof-agent"), provider);
  assert.equal((await affiliateBalance(service, agent)).payable_msats, "279");
  assert.equal((await affiliateBalance(service, parent)).payable_msats, "0");
  await verifyAffiliate(
    service,
    parent,
    pubkey,
    hash("proof-parent"),
    provider,
  );
  assert.equal((await affiliateBalance(service, parent)).payable_msats, "139");
  const unpaid = await issue("unpaid", 1_000);
  assert.equal((await affiliateBalance(service, agent)).pending_msats, "140");
  await Promise.all([
    service.settle(unpaid.hash, 1_000, "test"),
    service.settle(unpaid.hash, 1_000, "test"),
  ]);
  assert.equal((await affiliateBalance(service, agent)).payable_msats, "419");
  advance(AFFILIATE_VERIFICATION_MS);
  assert.equal((await affiliateBalance(service, agent)).payable_msats, "0");
  assert.equal((await affiliateBalance(service, agent)).pending_msats, "419");
});

test("unknown keys, provider keys without per-address authority, replay and revoked agents cannot unlock balances", async () => {
  const { service, provider, store } = setup();
  await assert.rejects(
    verifyAffiliate(service, agent, "ff".repeat(32), hash("bad"), provider),
    /does not match/,
  );
  for (const record of [
    { nostrPubkey: pubkey },
    { version: 1, affiliates: {} },
    { version: 1, affiliates: { [agent]: { nostr_pubkey: "bad" } } },
  ]) {
    await assert.rejects(
      verifyAffiliate(
        service,
        agent,
        pubkey,
        hash("bad-record"),
        async () => record,
      ),
    );
  }
  assert.equal((await affiliateBalance(service, agent)).verified, false);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      verifyAffiliate(service, agent, pubkey, hash("replay"), provider),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(
    verifyAffiliate(service, agent, pubkey, hash("replay"), provider),
    /already consumed/,
  );
  await store.transaction("oracle-crl", (tx) =>
    tx.revoke(agent, new Date(now).toISOString()),
  );
  await assert.rejects(
    verifyAffiliate(service, agent, pubkey, hash("new-proof"), provider),
    /revoked/,
  );
  assert.equal((await affiliateBalance(service, agent)).verified, false);
});

test("provider metadata URL is derived from the address, blocks unsafe origins and has no caller-key fallback", async () => {
  assert.equal(
    affiliateRecordUrl(agent).href,
    "https://example.com/.well-known/bitcoin-stratigraphy-affiliates.json",
  );
  await assert.rejects(
    providerOwnerKey(agent, async () => ({
      version: 1,
      affiliates: { [parent]: { nostr_pubkey: pubkey } },
    })),
  );
  assert.throws(() => affiliateRecordUrl("a@127.0.0.1"));
  assert.throws(() => affiliateRecordUrl("a@localhost"));
  assert.throws(() => affiliateRecordUrl("lnurl1invalid"));
  const reader = createAffiliateProviderReader({
    resolve: (async () => [{ address: "127.0.0.1", family: 4 }]) as never,
  });
  await assert.rejects(
    reader(new URL("https://example.com/record")),
    /nonpublic/,
  );
  const mixed = createAffiliateProviderReader({
    resolve: (async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]) as never,
  });
  await assert.rejects(
    mixed(new URL("https://example.com/record")),
    /nonpublic/,
  );
});

test("HTTPS reader pins lookup, rejects redirects and caps provider bodies", async () => {
  for (const mode of ["ok", "redirect", "oversize"]) {
    const request = ((
      options: Record<string, unknown>,
      callback: (res: Readable) => void,
    ) => {
      assert.equal(options.hostname, "example.com");
      const lookup = options.lookup as Function;
      lookup(
        "example.com",
        { all: true },
        (err: unknown, addresses: unknown) => {
          assert.equal(err, null);
          assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
        },
      );
      const outgoing = new EventEmitter() as EventEmitter & { end: () => void };
      outgoing.end = () => {
        const response = Readable.from([
          Buffer.from(
            mode === "oversize" ? "x".repeat(65_537) : '{"version":1}',
          ),
        ]);
        Object.assign(response, {
          statusCode: mode === "redirect" ? 302 : 200,
          headers: { "content-type": "application/json" },
          complete: true,
        });
        callback(response);
      };
      return outgoing;
    }) as never;
    const reader = createAffiliateProviderReader({
      resolve: (async () => [{ address: "8.8.8.8", family: 4 }]) as never,
      request,
    });
    if (mode === "ok")
      assert.deepEqual(await reader(new URL("https://example.com/record")), {
        version: 1,
      });
    else await assert.rejects(reader(new URL("https://example.com/record")));
  }
});

test("old invoice amounts/signatures survive reward upgrades while new challenge scopes change", async () => {
  const { service, store } = setup();
  const old = {
    hash: hash("old"),
    provider: "test",
    amount_msats: "100000",
    payout: agent,
    kickback_msats: "5000",
    allocation: { historic: true },
  };
  await store.transaction("old", (tx) => tx.putInvoice(old));
  const ctx = { payout: agent, invoices: new Map() };
  assert.deepEqual(
    await service.issue(
      { paymentHash: old.hash, provider: "test" },
      100_000,
      ctx,
    ),
    old,
  );
  assert.ok(
    enterpriseContext.run(ctx, enterpriseChallengeScope).endsWith(":21-cap-v1"),
  );
  await service.settle(old.hash, 100_000, "test");
  assert.equal((await affiliateBalance(service, agent)).pending_msats, "5000");
});

test("REST verification binds signature to URL, method, exact body and provider key; CRL blocks issuance immediately", async (t) => {
  const { service, provider, issue } = setup();
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, bytes) => {
        (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(bytes);
      },
    }),
  );
  registerAffiliateRoutes(app, service, { readProvider: provider });
  registerOracleCrlRoutes(app, service, "test-operator-only");
  registerCertifiedOracleRoutes(app, service);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = "/api/v1/affiliate/verify";
  const body = JSON.stringify({ agent_id: agent });
  const headers = (
    input = body,
    url = base + path,
    method = "POST",
    created = now / 1000,
    signingKey = secret,
  ) => {
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: created,
        content: "",
        tags: [
          ["u", url],
          ["method", method],
          ["payload", hash(input)],
        ],
      },
      signingKey,
    );
    return {
      "content-type": "application/json",
      Authorization:
        "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64"),
    };
  };
  assert.equal(
    (
      await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    ).status,
    401,
  );
  for (const signedHeaders of [
    headers(body, base + "/wrong"),
    headers(body, base + path, "GET"),
    headers(JSON.stringify({ agent_id: parent })),
    headers(body, base + path, "POST", now / 1000 - 120),
  ]) {
    assert.equal(
      (
        await fetch(base + path, {
          method: "POST",
          headers: signedHeaders,
          body,
        })
      ).status,
      401,
    );
  }
  const impostor = headers(
    body,
    base + path,
    "POST",
    now / 1000,
    generateSecretKey(),
  );
  assert.equal(
    (await fetch(base + path, { method: "POST", headers: impostor, body }))
      .status,
    403,
  );
  const good = headers();
  assert.equal(
    (await fetch(base + path, { method: "POST", headers: good, body })).status,
    200,
  );
  assert.equal(
    (await fetch(base + path, { method: "POST", headers: good, body })).status,
    403,
  );
  const balance = await fetch(
    base + "/api/v1/affiliate/balance/" + encodeURIComponent(agent),
  );
  assert.equal(balance.headers.get("cache-control"), "no-store");
  assert.equal((await balance.json()).verified, true);
  const invoice = await issue("credential");
  await service.settle(invoice.hash, 10_000_000_000, "test");
  const credential = await certifiedOracleStatus(service, agent);
  assert.equal(credential.eligible, true);
  assert.ok(credential.credential!.credentialStatus);
  const crl = base + "/api/v1/compliance/crl";
  assert.deepEqual(await (await fetch(crl)).json(), []);
  assert.equal(
    (
      await fetch(crl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(crl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer test-operator-only",
        },
        body,
      })
    ).status,
    200,
  );
  assert.deepEqual(await (await fetch(crl)).json(), [agent]);
  assert.equal((await certifiedOracleStatus(service, agent)).revoked, true);
  assert.equal(
    (
      await fetch(
        base +
          "/api/v1/compliance/certified-oracle/" +
          encodeURIComponent(agent),
      )
    ).status,
    403,
  );
  assert.equal((await affiliateBalance(service, agent)).payable_msats, "0");
});

test("credential jti revocations are durable and service failures never return an empty CRL", async (t) => {
  const { service, issue, store } = setup();
  const invoice = await issue("jti");
  await service.settle(invoice.hash, 10_000_000_000, "test");
  const issued = await certifiedOracleStatus(service, agent);
  const id = String(issued.credential!.id);
  await store.transaction("oracle-crl", (tx) => tx.revoke(id, "test"));
  assert.equal((await certifiedOracleStatus(service, agent)).revoked, true);
  const failed = new EnterpriseEconomics({
    transaction: async () => {
      throw new Error("offline");
    },
  });
  const app = express();
  registerOracleCrlRoutes(app, failed, "");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/compliance/crl`,
  );
  assert.equal(response.status, 503);
});
