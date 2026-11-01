import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { bech32 } from "@scure/base";
import express from "express";
import { pool } from "@workspace/db";
import { createPrivateYieldEarnings } from "../../src/lib/private-yield-earnings";
import { registerClaimYieldRoute } from "../../src/routes/claim-yield";
import { createSubscriptionMacaroon, attenuateSubscriptionMacaroon } from "../../src/lib/subscription-pass";
import { createPublicYieldLedger } from "../../src/lib/public-yield-ledger";
import { parseYieldWithdrawalInvoice } from "../../src/lib/yield-withdrawal-invoice";
import { apiRootAliases } from "../../src/middleware/apiRootAliases";
import { migratePayoutFixture, mockNwcPayout, mockPayoutHash, mockNwcUri } from "../helpers/nwc-payout";
import { createNwcPayout, type PayoutNwcClient } from "../../src/lib/nwc-payout";
import { Nip47WalletError } from "@getalby/sdk";

const secret = "private-yield-regression-secret";
const clock = Date.parse("2026-11-01T12:00:00Z");
const hash = () => randomBytes(32).toString("hex");
function invoice(msats: bigint, paymentHash = mockPayoutHash(), time = clock): string {
  let timestamp = Math.floor(time / 1000);
  const words = Array(7).fill(0);
  for (let i = 6; i >= 0; i--) { words[i] = timestamp % 32; timestamp = Math.floor(timestamp / 32); }
  words.push(1, 1, 20, ...bech32.toWords(Buffer.from(paymentHash, "hex")));
  // Description "mock" and a placeholder recoverable signature: no real wallet is called.
  const description = bech32.toWords(Buffer.from("mock"));
  words.push(13, 0, description.length, ...description, ...Array(104).fill(0));
  return bech32.encode(`lnbc${msats * 10n}p`, words, 4096);
}
function receipt(paymentHash: string, sats = 100): string {
  const root = createSubscriptionMacaroon({
    secret, paymentHash, tier: "1-day", validUntil: 1, // Expired access is still a historical paid receipt.
    amountMsats: sats * 1000, paymentAsset: "btc-lightning", paymentProvider: "test-wallet",
  });
  return attenuateSubscriptionMacaroon(root, ["allowed_path=/paid", "max_requests=1"])!;
}

test("BOLT11 BTC, milli, micro, nano and pico units convert to exact millisatoshis", () => {
  const { words } = bech32.decode(invoice(21_000n) as `${string}1${string}`, 4096);
  for (const [prefix, expected] of [
    ["lnbc1", 100_000_000_000n], ["lnbc1m", 100_000_000n],
    ["lnbc1u", 100_000n], ["lnbc1n", 100n], ["lnbc10p", 1n], ["lnbc210n", 21_000n],
  ] as const) {
    assert.equal(parseYieldWithdrawalInvoice(bech32.encode(prefix, words, 4096), clock).amountMsats, expected);
  }
  assert.throws(() => parseYieldWithdrawalInvoice(bech32.encode("lnbc1p", words, 4096), clock));
});

test("NWC evidence is invoice-bound; ambiguous results, missing history and CI live transport fail closed", async () => {
  const preimage = hash();
  const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  const text = invoice(21_000n, paymentHash);
  const parsed = parseYieldWithdrawalInvoice(text, clock);
  let response: unknown = { preimage, fees_paid: 0 };
  let error: Error | undefined;
  let closed = 0;
  let sends = 0;
  const client = createNwcPayout({ uri: () => mockNwcUri,
    clientFactory: uri => {
      assert.equal(uri, mockNwcUri);
      return {
        async payInvoice(request) {
          assert.deepEqual(request, { invoice: text });
          sends++;
          if (error) throw error;
          return response as Awaited<ReturnType<PayoutNwcClient["payInvoice"]>>;
        },
        async lookupInvoice(request) {
          assert.deepEqual(request, { payment_hash: paymentHash });
          if (error) throw error;
          return response as Awaited<ReturnType<PayoutNwcClient["lookupInvoice"]>>;
        },
        close() { closed++; },
      };
    } });
  assert.deepEqual(await client.pay(text, parsed),
    { status: "settled", txid: paymentHash, preimage });
  response = { preimage: hash() };
  assert.equal((await client.pay(text, parsed)).status, "pending");
  response = { success: true };
  assert.equal((await client.pay(text, parsed)).status, "pending");
  for (const code of ["INTERNAL", "OTHER", "PAYMENT_FAILED", "NOT_FOUND", "ALREADY_PAID"]) {
    error = new Nip47WalletError("untrusted wallet message", code);
    assert.equal((await client.pay(text, parsed)).status, "pending");
  }
  error = Object.assign(new Error("unverified rejection"), { code: "INSUFFICIENT_BALANCE" });
  assert.equal((await client.pay(text, parsed)).status, "pending", "A generic transport error cannot release funds");
  for (const code of ["INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "NOT_IMPLEMENTED"]) {
    error = new Nip47WalletError("mock wallet rejection", code);
    assert.equal((await client.pay(text, parsed)).status, "failed");
  }
  error = new Nip47WalletError("missing transaction", "NOT_FOUND");
  assert.equal((await client.lookup(parsed)).status, "pending", "Missing history is NOT proof of failure");
  error = undefined;
  response = { type: "incoming", state: "settled", payment_hash: paymentHash, preimage, amount: 21000, settled_at: 1 };
  assert.equal((await client.lookup(parsed)).status, "pending", "Incoming wallet records cannot prove an outgoing claim");
  response = { ...response as object, type: "outgoing", amount: 22000 };
  assert.equal((await client.lookup(parsed)).status, "pending", "Reconciliation must bind the exact outgoing amount");
  response = { ...response as object, amount: 21000, payment_hash: hash() };
  assert.equal((await client.lookup(parsed)).status, "pending");
  response = { ...response as object, payment_hash: paymentHash };
  assert.equal((await client.lookup(parsed)).status, "settled");
  response = { ...response as object, preimage: undefined };
  assert.equal((await client.lookup(parsed)).status, "settled", "Exact terminal outgoing evidence may omit preimage");
  response = { ...response as object, preimage: hash() };
  assert.equal((await client.lookup(parsed)).status, "pending", "An invalid present preimage fails closed");
  response = { ...response as object, state: "failed" };
  assert.equal((await client.lookup(parsed)).status, "pending", "An older failed attempt cannot release the current reservation");
  assert.equal(createNwcPayout({ uri: () => mockNwcUri }).configured(), false,
    "NODE_ENV=test forbids the default live transport");
  assert.equal(createNwcPayout({ uri: () => "invalid", clientFactory: () => { throw new Error("unreachable"); } }).configured(), false);
  assert.ok(closed > sends, "Every send and read closes its dedicated client");
});

test("NWC hangs return pending and close the client without retrying pay_invoice", async () => {
  let closed = 0, sends = 0;
  const client = createNwcPayout({
    uri: () => mockNwcUri, timeoutMs: 5,
    clientFactory: () => ({
      payInvoice() { sends++; return new Promise(() => {}); },
      lookupInvoice() { return new Promise(() => {}); },
      close() { closed++; },
    }),
  });
  const text = invoice(21000n), parsed = parseYieldWithdrawalInvoice(text, clock);
  assert.equal((await client.pay(text, parsed)).status, "pending");
  assert.equal((await client.lookup(parsed)).status, "pending");
  assert.equal(sends, 1);
  assert.equal(closed, 2);
});

test("private yield claims are durable, atomic and double-spend safe against real PostgreSQL", async t => {
  const schema = "yield_claim_test_" + randomBytes(8).toString("hex");
  assert.match(schema, /^[a-z0-9_]+$/);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const isolated = { connect: async () => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  } } as typeof pool;
  const fixture = await isolated.connect();
  const logs: Record<string, unknown>[] = [];
  const coinos = mockNwcPayout();
  let currentClock = clock;
  const app = express();
  app.use(apiRootAliases);
  app.use(express.json());
  const earnings = createPrivateYieldEarnings(isolated, () => currentClock, coinos.client);
  registerClaimYieldRoute(app, earnings, {
    secret, now: () => currentClock, logSettlement: event => { logs.push(event); }, operatorSecret: "test-operator",
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/claim-yield`;
  const send = (macaroons: string[], bolt11_invoice = invoice(BigInt(macaroons.length) * 21_000n)) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ macaroons, bolt11_invoice }) });
  const seed = async (sats = 100) => {
    const paymentHash = hash();
    await fixture.query("INSERT INTO revenue_ledger VALUES ($1,'L402',$2)", [paymentHash, sats]);
    return { hash: paymentHash, macaroon: receipt(paymentHash, sats) };
  };
  try {
    await fixture.query(`
      CREATE TABLE revenue_ledger (payment_hash text PRIMARY KEY, channel text NOT NULL, sats_received bigint NOT NULL);
      CREATE TABLE private_yield_claims (
        id text PRIMARY KEY, invoice_payment_hash text NOT NULL UNIQUE, invoice_digest text NOT NULL,
        total_msats bigint NOT NULL, settlement_mode text NOT NULL DEFAULT 'mock', created_at timestamptz NOT NULL);
      CREATE TABLE private_yield_earnings (
        payment_hash text PRIMARY KEY, provider text NOT NULL, gross_msats bigint NOT NULL,
        earned_msats bigint NOT NULL, balance_msats bigint NOT NULL,
        claim_id text REFERENCES private_yield_claims(id), claimed_at timestamptz);
      CREATE TABLE private_swarm_royalties (
        payment_hash text PRIMARY KEY, owner text NOT NULL, provider text NOT NULL,
        gross_msats bigint NOT NULL, earned_msats bigint NOT NULL, balance_msats bigint NOT NULL,
        claim_id text REFERENCES private_yield_claims(id), claimed_at timestamptz);
    `);
    await migratePayoutFixture(fixture);
    coinos.observe(async invoice => {
      const state = await fixture.query(
        "SELECT payment_status FROM private_yield_claims WHERE invoice_payment_hash=$1", [invoice.paymentHash]);
      assert.equal(state.rows[0]?.payment_status, "pending", "Pending state must be committed BEFORE outbound HTTP");
      const reservations = await fixture.query(
        "SELECT COUNT(*)::int AS count FROM private_yield_payout_items i JOIN private_yield_claims c ON c.id=i.claim_id WHERE c.invoice_payment_hash=$1",
        [invoice.paymentHash]);
      assert.ok(reservations.rows[0].count > 0);
    });
    await t.test("successful mocked NWC settlement fully deducts balances; replay and descendants fail", async () => {
      const item = await seed();
      const result = await send([item.macaroon]);
      assert.equal(result.status, 200);
      const body = await result.json();
      assert.equal(body.status, "SETTLED");
      assert.equal(body.payment_sent, true);
      assert.ok(body.coinos_txid);
      assert.equal(body.simulated, undefined);
      assert.equal(body.claimed_msats, "21000");
      assert.equal(body.remaining_balance_msats, "0");
      assert.equal((await send([item.macaroon])).status, 409);
      const descendant = attenuateSubscriptionMacaroon(item.macaroon, ["max_requests=1"])!;
      assert.equal((await send([descendant])).status, 409);
      const state = await fixture.query("SELECT balance_msats, claim_id FROM private_yield_earnings WHERE payment_hash=$1", [item.hash]);
      assert.equal(state.rows[0].balance_msats, "0");
      assert.equal(state.rows[0].claim_id, body.claim_id);
      // A recreated adapter sees committed state, not a process-local replay cache.
      await assert.rejects(createPrivateYieldEarnings(isolated, () => clock, coinos.client).claim(
        [{ paymentHash: item.hash, provider: "test-wallet", amountMsats: 100_000 }],
        { amountMsats: 21_000n, paymentHash: hash(), expiresAt: clock + 3600_000 }, "mock",
      ), (error: any) => error.status === 409);
      assert.equal(logs.length, 1);
    });
    await t.test("definitive NWC failure releases the reservation without consuming funds and permits retry", async () => {
      const item = await seed();
      const destination = invoice(21_000n);
      coinos.setMode("failure");
      assert.equal((await send([item.macaroon], destination)).status, 502);
      const state = await fixture.query("SELECT balance_msats,claim_id FROM private_yield_earnings WHERE payment_hash=$1", [item.hash]);
      assert.equal(state.rows[0].balance_msats, "21000");
      assert.equal(state.rows[0].claim_id, null);
      const failed = await fixture.query("SELECT payment_status FROM private_yield_claims WHERE invoice_digest=$1",
        [(await import("node:crypto")).createHash("sha256").update(destination).digest("hex")]);
      assert.equal(failed.rows[0].payment_status, "failed");
      coinos.setMode("success");
      assert.equal((await send([item.macaroon], destination)).status, 200);
    });
    await t.test("timeout remains pending across adapters and alternate invoices until authenticated reconciliation", async () => {
      const item = await seed();
      const destination = invoice(21_000n);
      coinos.setMode("timeout");
      const before = coinos.calls;
      const response = await send([item.macaroon], destination);
      assert.equal(response.status, 202);
      const pending = await response.json();
      assert.equal(pending.payment_sent, null);
      const state = await fixture.query("SELECT balance_msats,claim_id FROM private_yield_earnings WHERE payment_hash=$1", [item.hash]);
      assert.equal(state.rows[0].balance_msats, "21000");
      assert.equal(state.rows[0].claim_id, null);
      assert.equal((await send([item.macaroon], destination)).status, 202);
      currentClock = clock + 7200_000;
      try { assert.equal((await send([item.macaroon], destination)).status, 202, "Expired pending invoices can recover claim status without paying again"); }
      finally { currentClock = clock; }
      assert.equal((await send([item.macaroon])).status, 409);
      assert.equal(coinos.calls, before + 1, "Pending retries never pay_invoice again");
      const restarted = createPrivateYieldEarnings(isolated, () => clock, coinos.client);
      assert.equal((await restarted.claim([{ paymentHash: item.hash, provider: "test-wallet", amountMsats: 100_000 }],
        parseYieldWithdrawalInvoice(destination, clock), destination)).paymentStatus, "pending");
      const reconcile = (authorized: boolean) => fetch(url + "/reconcile", {
        method: "POST", headers: { "Content-Type": "application/json",
          ...(authorized ? { Authorization: "Bearer test-operator" } : {}) },
        body: JSON.stringify({ claim_id: pending.claim_id }),
      });
      assert.equal((await reconcile(false)).status, 403);
      coinos.setMode("success"); // Wallet history now confirms the original payment.
      assert.equal((await reconcile(true)).status, 200);
      assert.equal(coinos.calls, before + 1, "Reconciliation only reads history");
      assert.equal((await send([item.macaroon])).status, 409);
    });
    await t.test("ambiguous 5xx remains reserved; no automatic release or repayment", async () => {
      const item = await seed();
      coinos.setMode("ambiguous");
      assert.equal((await send([item.macaroon])).status, 202);
      assert.equal((await send([item.macaroon])).status, 409);
      coinos.setMode("success");
    });
    await t.test("successful external payment with a failed local connection stays reserved until reconciliation", async () => {
      const item = await seed();
      const destination = invoice(21_000n);
      let connections = 0;
      const outage = { connect: async () => {
        if (++connections === 2) throw new Error("Mock post-payment database outage");
        return isolated.connect();
      } } as typeof pool;
      const before = coinos.calls;
      const pending = await createPrivateYieldEarnings(outage, () => clock, coinos.client).claim(
        [{ paymentHash: item.hash, provider: "test-wallet", amountMsats: 100_000 }],
        parseYieldWithdrawalInvoice(destination, clock), destination);
      assert.equal(pending.paymentStatus, "pending");
      assert.equal((await send([item.macaroon])).status, 409);
      const state = await fixture.query("SELECT balance_msats FROM private_yield_earnings WHERE payment_hash=$1", [item.hash]);
      assert.equal(state.rows[0].balance_msats, "21000");
      assert.equal((await earnings.reconcile!(pending.claimId)).paymentStatus, "settled");
      assert.equal(coinos.calls, before + 1, "Database recovery never sends another payment");
    });
    await t.test("combined 21% yield and 5% owner royalty reservations release or settle together", async () => {
      const item = await seed();
      const royalty = hash(), owner = hash();
      await fixture.query("INSERT INTO private_swarm_royalties VALUES ($1,$2,'test-wallet',100000,5000,5000,NULL,NULL)", [royalty, owner]);
      const text = invoice(26_000n), parsed = parseYieldWithdrawalInvoice(text, clock);
      const selected = [{ paymentHash: item.hash, provider: "test-wallet", amountMsats: 100_000 }];
      coinos.setMode("failure");
      await assert.rejects(earnings.claim(selected, parsed, text, { owner, paymentHashes: [royalty] }),
        (error: any) => error.status === 502);
      assert.equal((await fixture.query("SELECT balance_msats FROM private_swarm_royalties WHERE payment_hash=$1", [royalty])).rows[0].balance_msats, "5000");
      coinos.setMode("timeout");
      const pending = await earnings.claim(selected, parsed, text, { owner, paymentHashes: [royalty] });
      assert.equal(pending.paymentStatus, "pending");
      assert.equal((await fixture.query("SELECT COUNT(*)::int AS count FROM private_yield_payout_items WHERE claim_id=$1", [pending.claimId])).rows[0].count, 2);
      coinos.setMode("success");
      assert.equal((await earnings.reconcile!(pending.claimId)).paymentStatus, "settled");
      assert.equal((await fixture.query("SELECT balance_msats FROM private_swarm_royalties WHERE payment_hash=$1", [royalty])).rows[0].balance_msats, "0");
      assert.equal((await fixture.query("SELECT balance_msats FROM private_yield_earnings WHERE payment_hash=$1", [item.hash])).rows[0].balance_msats, "0");
    });
    await t.test("stale reconciliation cannot release a newer same-invoice attempt", async () => {
      const item = await seed(), text = invoice(21_000n), parsed = parseYieldWithdrawalInvoice(text, clock);
      const selected = [{ paymentHash: item.hash, provider: "test-wallet", amountMsats: 100_000 }];
      coinos.setMode("timeout");
      const initial = await earnings.claim(selected, parsed, text);
      let entered!: () => void, finish!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const failure = { status: "failed" as const, code: "MOCK_VERIFIED_FAILURE" };
      const slow = createPrivateYieldEarnings(isolated, () => clock, {
        ...coinos.client, lookup: async () => { entered(); await gate; return failure; },
      });
      const delayed = slow.reconcile!(initial.claimId);
      await started;
      const verifier = createPrivateYieldEarnings(isolated, () => clock, { ...coinos.client, lookup: async () => failure });
      assert.equal((await verifier.reconcile!(initial.claimId)).paymentStatus, "failed");
      const retry = await earnings.claim(selected, parsed, text);
      assert.equal(retry.attempt, 2);
      finish();
      assert.equal((await delayed).paymentStatus, "pending");
      assert.equal((await fixture.query("SELECT COUNT(*)::int AS count FROM private_yield_payout_items WHERE claim_id=$1", [retry.claimId])).rows[0].count, 1);
      coinos.setMode("success");
      assert.equal((await earnings.reconcile!(retry.claimId)).paymentStatus, "settled");
    });
    await t.test("concurrent requests have exactly one winner", async () => {
      const item = await seed();
      const responses = await Promise.all(Array.from({ length: 8 }, () => send([item.macaroon])));
      assert.deepEqual(responses.map(response => response.status).sort(), [200,409,409,409,409,409,409,409]);
    });
    await t.test("mixed batches roll back completely and duplicates cannot multiply earnings", async () => {
      const used = await seed();
      const fresh = await seed();
      assert.equal((await send([used.macaroon])).status, 200);
      assert.equal((await send([fresh.macaroon, used.macaroon])).status, 409);
      const child = attenuateSubscriptionMacaroon(fresh.macaroon, ["max_requests=1"])!;
      assert.equal((await send([fresh.macaroon, child])).status, 400);
      assert.equal((await send([fresh.macaroon])).status, 200);
      const a = await seed(); const b = await seed();
      const batch = await send([a.macaroon,b.macaroon]);
      assert.equal(batch.status, 200);
      assert.equal((await batch.json()).claimed_msats, "42000");
    });
    await t.test("unpaid, tampered and wrong-amount receipts cannot establish earnings", async () => {
      assert.equal((await send([receipt(hash())])).status, 404);
      assert.equal((await send(["forged"])).status, 403);
      const item = await seed();
      assert.equal((await send([receipt(item.hash, 101)])).status, 403);
      assert.equal((await send([item.macaroon], invoice(20_000n))).status, 400);
      assert.equal((await send([item.macaroon], invoice(21_000n, hash(), clock - 7200_000))).status, 400);
      assert.equal((await send([item.macaroon], "lnbc" + "q".repeat(120))).status, 400);
      assert.equal((await send([item.macaroon])).status, 200);
    });
    await t.test("invoice reuse rolls back the second balance and no bearer data enters mock logs", async () => {
      const a = await seed(); const b = await seed();
      const destination = invoice(21_000n);
      assert.equal((await send([a.macaroon], destination)).status, 200);
      assert.equal((await send([b.macaroon], destination)).status, 409);
      assert.equal((await send([b.macaroon])).status, 200);
      assert.doesNotMatch(JSON.stringify(logs), new RegExp(a.macaroon + "|" + destination));
      assert.deepEqual(createPublicYieldLedger().snapshot(), []);
    });
    await t.test("storage failures are explicit rather than mocked successful payments", async () => {
      const broken = express(); broken.use(express.json());
      registerClaimYieldRoute(broken, { claim: async () => { throw new Error("database down"); } },
        { secret, now: () => clock });
      const listener = broken.listen(0, "127.0.0.1");
      await once(listener, "listening");
      try {
        const response = await fetch(`http://127.0.0.1:${(listener.address() as any).port}/api/claim-yield`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ macaroons: [receipt(hash())], bolt11_invoice: invoice(21_000n) }),
        });
        assert.equal(response.status, 503);
      } finally { listener.close(); await once(listener, "close"); }
    });
    await t.test("API-server-relative OpenAPI alias reaches the identical claim endpoint", async () => {
      const item = await seed();
      const response = await fetch(url.replace("/api/claim-yield", "/api/api/claim-yield"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macaroons: [item.macaroon], bolt11_invoice: invoice(21_000n) }),
      });
      assert.equal(response.status, 200);
      assert.equal((await send([item.macaroon])).status, 409);
    });
  } finally {
    server.close(); await once(server, "close");
    fixture.release();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
