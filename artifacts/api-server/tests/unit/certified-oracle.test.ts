import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { canonical } from "../../src/lib/article12-signature";
import {
  EnterpriseEconomics,
  enterpriseContext,
  enterpriseChallengeScope,
  configureEnterpriseEconomics,
  bindEnterpriseInvoiceToContext,
  type EnterpriseContext,
} from "../../src/lib/enterprise-economics";
import {
  createMemoryEnterpriseEconomicsStore,
  createPostgresEnterpriseEconomicsStore,
} from "../../src/lib/enterprise-economics-store";
import {
  certifiedOracleStatus,
  ORACLE_STATUS,
  ORACLE_VALIDITY_SECONDS,
} from "../../src/lib/certified-oracle";
import { createEnterpriseEconomicsMiddleware } from "../../src/middleware/enterprise-economics";
import { registerCertifiedOracleRoutes } from "../../src/routes/certified-oracle";

const keys = generateKeyPairSync("ed25519");
const now = Date.parse("2026-10-24T00:00:00Z");
const hash = (id: string) => createHash("sha256").update(id).digest("hex");
const payout = "agent@example.com";
const parent = "parent@example.com";
const threshold = 10_000_000_000;
function setup(price: number | null = 10_000_000) {
  const store = createMemoryEnterpriseEconomicsStore();
  const service = new EnterpriseEconomics(
    store,
    async () => price,
    () => keys.privateKey,
    () => now,
  );
  const context = (parentPayout?: string): EnterpriseContext => ({
    payout,
    parentPayout,
    invoices: new Map(),
  });
  const volume = (id = payout) =>
    store.transaction("read:" + id, (tx) => tx.routingVolume(id));
  const issue = (id: string, amount: number, ctx = context(parent)) =>
    service.issue({ paymentHash: hash(id), provider: "test" }, amount, ctx);
  return { store, service, context, issue, volume };
}

test("multi-tier allocations floor 14%/7%, use 21% without a parent and remain signed ledger entries", async () => {
  const { service, context, issue, volume, store } = setup();
  let confirmed = 0;
  for (const amount of [1, 19, 20, 99, 100, 1_999, 101_001]) {
    const invoice = await issue(String(amount), amount);
    assert.equal(
      invoice.direct_kickback_msats,
      String(Math.floor((amount * 14) / 100)),
    );
    assert.equal(
      invoice.parent_kickback_msats,
      String(Math.floor((amount * 7) / 100)),
    );
    assert.equal(invoice.parent_payout, parent);
    assert.equal(
      invoice.kickback_msats,
      String(
        BigInt(invoice.direct_kickback_msats!) +
          BigInt(invoice.parent_kickback_msats!),
      ),
    );
    assert.ok(BigInt(invoice.kickback_msats) <= (BigInt(amount) * 21n) / 100n);
    const { issuer_attestation, ...unsigned } = invoice.allocation;
    assert.ok(
      verify(
        null,
        Buffer.from(
          "bitcoin-stratigraphy/routing-kickback/v1\n" + canonical(unsigned),
        ),
        keys.publicKey,
        Buffer.from(
          (issuer_attestation as { signature: string }).signature,
          "base64",
        ),
      ),
    );
    assert.equal(await volume(), String(confirmed));
    await service.settle(invoice.hash, amount, "test");
    confirmed += amount;
    const saved = await store.transaction("saved", (tx) =>
      tx.invoice(invoice.hash),
    );
    assert.deepEqual(saved?.allocation, invoice.allocation);
    assert.ok(saved?.settled_at);
  }
  const legacy = await issue("legacy", 1_999, context());
  assert.equal(legacy.kickback_msats, "419");
  assert.equal(legacy.parent_payout, undefined);
  assert.equal(legacy.allocation.parent_payout_address, undefined);
  assert.equal(await volume(parent), "0");
  await assert.rejects(
    issue("invalid-parent", 100, {
      parentPayout: parent,
      invoices: new Map(),
    }),
    /distinct direct/,
  );
  await assert.rejects(
    issue("self-parent", 100, context(payout)),
    /distinct direct/,
  );
});

test("invoice/cache identity binds the parent without changing legacy scopes", async () => {
  const { service, context, issue } = setup();
  configureEnterpriseEconomics(service);
  const one = context(parent);
  const two = context("other@example.com");
  const scope = (ctx: EnterpriseContext) =>
    enterpriseContext.run(ctx, enterpriseChallengeScope);
  assert.notEqual(scope(one), scope(two));
  const legacyScope =
    ":economics:" + hash(JSON.stringify([undefined, payout, null]));
  assert.equal(scope(context()), legacyScope + ":21-cap-v1");
  const invoice = await issue("bound", 100_000, one);
  assert.deepEqual(await issue("bound", 100_000, one), invoice);
  await assert.rejects(issue("bound", 100_000, two), /already bound/);
  await assert.rejects(issue("bound", 100_000, context()), /already bound/);
  await assert.rejects(
    enterpriseContext.run(two, () =>
      bindEnterpriseInvoiceToContext(invoice.hash),
    ),
    /attribution mismatch/,
  );
  await enterpriseContext.run(one, () =>
    bindEnterpriseInvoiceToContext(invoice.hash),
  );
});

test("confirmed direct routing volume is replay-safe, concurrent-safe and independent of buyer spend", async () => {
  const { service, issue, volume } = setup();
  const invoice = await issue("confirmed", threshold);
  assert.equal(await volume(), "0");
  await assert.rejects(
    service.settle(invoice.hash, threshold - 1, "test"),
    /does not match/,
  );
  await assert.rejects(
    service.settle(invoice.hash, threshold, "other"),
    /does not match/,
  );
  assert.equal(await volume(), "0");
  await Promise.all(
    Array.from({ length: 8 }, () =>
      service.settle(invoice.hash, threshold, "test"),
    ),
  );
  assert.equal(await volume(), String(threshold));
  assert.equal(await volume(parent), "0");
  assert.equal(await volume("other@example.com"), "0");
  await issue("unpaid", threshold);
  assert.equal(await volume(), String(threshold));
  assert.equal((await service.status("ab".repeat(32))).total_msats, "0");
});

test("credential threshold counts exact settled volume and returns a verifiable, time-bounded VC-JWT", async () => {
  const { service, issue } = setup();
  const first = await issue("below", threshold - 1);
  await service.settle(first.hash, threshold - 1, "test");
  assert.equal((await certifiedOracleStatus(service, payout)).eligible, false);
  const last = await issue("one-msat", 1);
  await service.settle(last.hash, 1, "test");
  const result = await certifiedOracleStatus(service, payout);
  assert.equal(result.eligible, true);
  const { credential_jwt, verification, ...vc } = result.credential!;
  assert.equal(
    (vc.credentialSubject as Record<string, unknown>).status,
    ORACLE_STATUS,
  );
  assert.equal(
    (vc.credentialSubject as Record<string, unknown>)
      .hallucination_freedom_proven,
    false,
  );
  assert.equal(
    (vc.credentialSubject as Record<string, unknown>).payout_control_verified,
    false,
  );
  assert.equal(
    "d" in (verification as { public_key_jwk: object }).public_key_jwk,
    false,
  );
  const [header, body, signature] = String(credential_jwt).split(".");
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  const jose = JSON.parse(Buffer.from(header!, "base64url").toString());
  assert.equal(jose.alg, "EdDSA");
  assert.equal(jose.kid, vc.issuer);
  assert.deepEqual(claims.vc, vc);
  assert.equal(claims.iss, vc.issuer);
  assert.equal(claims.sub, (vc.credentialSubject as { id: string }).id);
  assert.equal(claims.nbf, now / 1_000);
  assert.equal(claims.exp - claims.nbf, ORACLE_VALIDITY_SECONDS);
  assert.ok(
    verify(
      null,
      Buffer.from(header + "." + body),
      keys.publicKey,
      Buffer.from(signature!, "base64url"),
    ),
  );
  const altered = structuredClone(claims);
  altered.vc.credentialSubject.cumulative_routed_msats = "999999999999";
  const alteredBody = Buffer.from(JSON.stringify(altered)).toString(
    "base64url",
  );
  assert.equal(
    verify(
      null,
      Buffer.from(header + "." + alteredBody),
      keys.publicKey,
      Buffer.from(signature!, "base64url"),
    ),
    false,
  );
});

test("routing USD eligibility uses the current quote and fails closed without usable FX or keys", async () => {
  for (const price of [null, 0, -1, 1.5, Number.NaN]) {
    const { service } = setup(price);
    await assert.rejects(
      certifiedOracleStatus(service, payout),
      /quote unavailable/,
    );
  }
  const { service, issue, store } = setup();
  const invoice = await issue("fx-threshold", threshold / 2);
  await service.settle(invoice.hash, threshold / 2, "test");
  assert.equal((await certifiedOracleStatus(service, payout)).eligible, false);
  const appreciated = new EnterpriseEconomics(
    store,
    async () => 20_000_000,
    () => keys.privateKey,
    () => now,
  );
  assert.equal(
    (await certifiedOracleStatus(appreciated, payout)).eligible,
    true,
  );
  const missingKey = new EnterpriseEconomics(
    store,
    async () => 20_000_000,
    () => {
      throw new Error("key unavailable");
    },
  );
  await assert.rejects(
    certifiedOracleStatus(missingKey, payout),
    /key unavailable/,
  );
});

test("REST quotes accept parent headers and credentials return 400/404/200/503 without invoices or payouts", async (t) => {
  const { service, issue, store } = setup();
  const app = express();
  app.use(createEnterpriseEconomicsMiddleware(service));
  app.all("/api/v1/cost", (_req, res) => res.json({ quote_only: true }));
  registerCertifiedOracleRoutes(app, service);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const method of ["GET", "POST"]) {
    const res = await fetch(base + "/api/v1/cost", {
      method,
      headers: {
        "X-Agent-LNURL": "agent@EXAMPLE.COM",
        "X-Parent-Agent-LNURL": parent,
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enterprise_economics.direct_kickback_percent, 14);
    assert.equal(body.enterprise_economics.parent_kickback_percent, 7);
    assert.equal(body.enterprise_economics.routing_kickback_percent, 21);
    assert.equal(body.enterprise_economics.parent_payout_address, parent);
    assert.equal(body.enterprise_economics.payout_address, payout);
  }
  for (const headers of [
    { "X-Parent-Agent-LNURL": parent },
    { "X-Agent-LNURL": payout, "X-Parent-Agent-LNURL": payout },
    { "X-Agent-LNURL": payout, "X-Parent-Agent-LNURL": "invalid" },
  ]) {
    assert.equal((await fetch(base + "/api/v1/cost", { headers })).status, 400);
  }
  const path = base + "/api/v1/compliance/certified-oracle/";
  assert.equal((await fetch(path + "invalid")).status, 400);
  let response = await fetch(path + encodeURIComponent(payout));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const invoice = await issue("route-credential", threshold);
  assert.equal((await fetch(path + encodeURIComponent(payout))).status, 404);
  await service.settle(invoice.hash, threshold, "test");
  response = await fetch(path + encodeURIComponent(payout));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).credentialSubject.status, ORACLE_STATUS);
  assert.equal((await fetch(path + encodeURIComponent(parent))).status, 404);
  const failed = express();
  registerCertifiedOracleRoutes(
    failed,
    new EnterpriseEconomics(store, async () => null),
  );
  const unavailable = failed.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => unavailable.once("listening", resolve));
  t.after(() => {
    unavailable.closeAllConnections();
    unavailable.close();
  });
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${(unavailable.address() as AddressInfo).port}/api/v1/compliance/certified-oracle/${encodeURIComponent(payout)}`,
      )
    ).status,
    503,
  );
});

test("PostgreSQL volume reads settled invoice totals with a bound payout parameter and rollback on failure", async () => {
  const queries: { sql: string; params?: unknown[] }[] = [];
  let fail = false;
  let releases = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("SUM(")) {
        if (fail) throw new Error("database unavailable");
        return { rows: [{ total: String(threshold) }] };
      }
      return { rows: [] };
    },
    release() {
      releases++;
    },
  };
  const database = { query: client.query, connect: async () => client };
  const store = createPostgresEnterpriseEconomicsStore(database as never);
  assert.equal(
    await store.transaction("routing:" + payout, (tx) =>
      tx.routingVolume(payout),
    ),
    String(threshold),
  );
  const aggregate = queries.find((q) => q.sql.includes("SUM("))!;
  assert.deepEqual(aggregate.params, [payout]);
  assert.match(aggregate.sql, /settled_at' IS NOT NULL/);
  assert.equal(queries.at(-1)?.sql, "COMMIT");
  fail = true;
  await assert.rejects(
    store.transaction("routing:" + payout, (tx) => tx.routingVolume(payout)),
    /database unavailable/,
  );
  assert.equal(queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(releases, 2);
});
