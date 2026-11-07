import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { after, test } from "node:test";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { pool } from "@workspace/db";
import { createYieldStaking, YieldStakingError } from "../../src/lib/yield-staking";
import { createPrivateYieldEarnings, YieldClaimError } from "../../src/lib/private-yield-earnings";
import { createL402Middleware } from "../../src/middleware/l402";
import { createMemoryRevenueLedger, type RevenueLedger } from "../../src/services/ledger";
import type { SettlementRouter } from "../../src/services/settlement";
import { registerMcpRoute, mcpToolDefinitions } from "../../src/routes/mcp";
import { mockNwcPayout, migratePayoutFixture } from "../helpers/nwc-payout";

const hash = () => randomBytes(32).toString("hex");
const secret = "staking-regression-secret-never-a-live-wallet";
const ownerKey = generateSecretKey(), otherKey = generateSecretKey();
const owner = getPublicKey(ownerKey), other = getPublicKey(otherKey);
function nip98(url: string, body: string, key = ownerKey, time = Math.floor(Date.now() / 1000)) {
  const event = finalizeEvent({ kind: 27235, created_at: time, content: "",
    tags: [["u", url], ["method", "POST"],
      ["payload", createHash("sha256").update(body).digest("hex")]] }, key);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
after(async () => { await pool.end(); });

test("all original 16 MCP definitions retain their exact pre-staking contracts", () => {
  const core = mcpToolDefinitions.filter(tool => tool.name !== "payment.get_escrow");
  assert.equal(core.length, 16);
  assert.equal(createHash("sha256").update(JSON.stringify(core)).digest("hex"),
    "56a85799a9933a62485b1fd17c35bc1af6550e7a49717794fbe3c033a32a2e12");
});

test("yield staking uses durable, exclusive receipt reservations across PostgreSQL workers", async t => {
  const schema = "staking_test_" + randomBytes(8).toString("hex");
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const database = { connect: async () => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  } } as typeof pool;
  const fixture = await database.connect();
  const servers: ReturnType<express.Express["listen"]>[] = [];
  try {
    await fixture.query(`
      CREATE TABLE revenue_ledger (payment_hash text PRIMARY KEY, channel text NOT NULL, sats_received bigint NOT NULL);
      CREATE TABLE private_yield_claims (
        id text PRIMARY KEY,invoice_payment_hash text UNIQUE NOT NULL,invoice_digest text NOT NULL,
        total_msats bigint NOT NULL,created_at timestamptz NOT NULL,settlement_mode text NOT NULL DEFAULT 'mock',
        CONSTRAINT private_yield_claim_mock_only CHECK(settlement_mode='mock'));
      CREATE TABLE private_yield_earnings (
        payment_hash text PRIMARY KEY,provider text NOT NULL,gross_msats bigint NOT NULL,
        earned_msats bigint NOT NULL,balance_msats bigint NOT NULL,claim_id text REFERENCES private_yield_claims(id),claimed_at timestamptz);
      CREATE TABLE private_swarm_royalties (
        payment_hash text PRIMARY KEY,owner text NOT NULL,provider text NOT NULL,gross_msats bigint NOT NULL,
        earned_msats bigint NOT NULL,balance_msats bigint NOT NULL,claim_id text REFERENCES private_yield_claims(id),claimed_at timestamptz);
    `);
    await migratePayoutFixture(fixture);
    const a = createYieldStaking(database), b = createYieldStaking(database);
    const seed = async (amountMsats = 250000, pubkey = owner) => {
      const receipt = { pubkey, paymentHash: hash(), provider: "test-wallet", amountMsats };
      await fixture.query("INSERT INTO revenue_ledger VALUES ($1,'L402',$2)",
        [receipt.paymentHash, Math.ceil(amountMsats / 1000)]);
      return receipt;
    };
    await t.test("concurrent retries, worker restarts, and fractional sats credit exactly once", async () => {
      const receipt = await seed(237500);
      await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).credit(receipt)));
      assert.equal((await a.get(owner)).staked_sats, 49);
      const second = await seed(237500);
      await Promise.all([a.credit(second), b.credit(second)]);
      assert.equal((await createYieldStaking(database).get(owner)).staked_sats, 99);
      const total = await fixture.query("SELECT staked_msats::text AS msats FROM yield_staking_accounts");
      assert.equal(total.rows[0].msats, "99750");
      await assert.rejects(a.credit({ ...receipt, pubkey: other }), YieldStakingError);
      await assert.rejects(a.credit({ ...receipt, amountMsats: 237501 }), YieldStakingError);
      assert.equal((await a.get(other)).staked_sats, 0);
      await assert.rejects(a.credit({ ...receipt, paymentHash: hash() }), YieldStakingError);
    });
    await t.test("many distinct invoices sharing one owner do not lose increments", async () => {
      const receipts = await Promise.all(Array.from({ length: 20 }, () => seed(100000, other)));
      await Promise.all(receipts.map((r, i) => (i % 2 ? a : b).credit(r)));
      assert.equal((await a.get(other)).staked_sats, 420);
    });
    await t.test("VIP is strictly above 10000 sats and reads never initialize accounts", async () => {
      const key = getPublicKey(generateSecretKey());
      assert.deepEqual(await a.get(key), { pubkey: key, staked_sats: 0, vip_status: false,
        unlocked_features: ["zero_latency_routing"] });
      await a.credit(await seed(47620000, key));
      assert.equal((await a.get(key)).staked_sats, 10000);
      assert.equal((await a.get(key)).vip_status, false);
      await a.credit(await seed(5000, key));
      assert.equal((await a.get(key)).vip_status, true);
    });
    await t.test("staking and withdrawal race for one receipt, including pending wallet outcomes", async () => {
      const payout = mockNwcPayout();
      // No live wallet calls: unknown outgoing outcomes remain reserved.
      payout.setMode("ambiguous");
      const claims = createPrivateYieldEarnings(database, Date.now, payout.client);
      for (let i = 0; i < 10; i++) {
        const receipt = await seed();
        const invoice = { paymentHash: hash(), amountMsats: 52500n,
          expiresAt: Date.now() + 60000, network: "bitcoin" as const };
        const results = await Promise.allSettled([
          (i % 2 ? b : a).credit(receipt),
          claims.claim([receipt], invoice as Parameters<typeof claims.claim>[1], "mock-invoice"),
        ]);
        assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
        const staked = await fixture.query("SELECT 1 FROM yield_staking_receipts WHERE payment_hash=$1", [receipt.paymentHash]);
        const reserved = await fixture.query("SELECT 1 FROM private_yield_payout_items WHERE payment_hash=$1", [receipt.paymentHash]);
        assert.equal(staked.rowCount! + reserved.rowCount!, 1);
        if (staked.rowCount) {
          await assert.rejects(claims.claim([receipt], { ...invoice, paymentHash: hash() } as never, "another"),
            (e: unknown) => e instanceof YieldClaimError && e.code === "YIELD_ALREADY_STAKED");
        } else {
          await assert.rejects(a.credit(receipt), YieldStakingError);
        }
      }
    });
    await t.test("database errors roll back both the receipt and account increment", async () => {
      const receipt = await seed(250000, getPublicKey(generateSecretKey()));
      await fixture.query(`CREATE FUNCTION reject_stake() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected write failure'; END $$;
        CREATE TRIGGER reject_stake BEFORE INSERT ON yield_staking_receipts FOR EACH ROW EXECUTE FUNCTION reject_stake();`);
      await assert.rejects(a.credit(receipt));
      assert.equal((await a.get(receipt.pubkey)).staked_sats, 0);
      assert.equal((await fixture.query("SELECT 1 FROM yield_staking_receipts WHERE payment_hash=$1", [receipt.paymentHash])).rowCount, 0);
      await fixture.query("DROP TRIGGER reject_stake ON yield_staking_receipts");
      await a.credit(receipt);
      assert.equal((await a.get(receipt.pubkey)).staked_sats, 52);
    });
    const memory = createMemoryRevenueLedger();
    const ledger: RevenueLedger = { ...memory, async record(entry) {
      await fixture.query("INSERT INTO revenue_ledger VALUES ($1,'L402',$2) ON CONFLICT DO NOTHING",
        [entry.paymentHash, entry.satsReceived]);
      await memory.record(entry);
    } };
    const invoices = new Map<string, { preimage: string; amount: number; description: string; paid: boolean }>();
    let executions = 0;
    const router: SettlementRouter = {
      isConfigured: () => true, activeProvider: () => "test-wallet", circuitState: () => "closed",
      async createInvoice(input) {
        const preimage = hash(), paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
        invoices.set(paymentHash, { preimage, amount: input.amountMsats, description: input.description, paid: true });
        return { invoice: "lnbc1stakingtest", paymentHash, provider: "test-wallet" };
      },
      async verifyPayment(input) {
        const invoice = invoices.get(input.paymentHash);
        if (!invoice?.paid || invoice.preimage !== input.preimage || input.expectedAmountMsats !== invoice.amount ||
            input.expectedDescription !== invoice.description) return "invalid";
        return { settledAt: Math.floor(Date.now() / 1000), provider: "test-wallet" };
      },
    };
    const worker = async (store = a) => {
      const app = express();
      app.use(express.json());
      app.locals.yieldStaking = store;
      app.post("/paid", createL402Middleware({ amountSats: 250, description: "staking test",
        settlementRouter: router, sessionSecret: secret, ledger, allowBatch: true }),
        (_req, res) => { executions++; res.json({ executed: true }); });
      registerMcpRoute(app, { yieldStaking: store, sessionSecret: secret, x402ResourceServer: null });
      const server = app.listen(0, "127.0.0.1"); servers.push(server); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    };
    const url = await worker();
    const post = async (path: string, body: object, headers: Record<string, string> = {}, key = ownerKey) => {
      const text = JSON.stringify(body), target = path.startsWith("http") ? path : url + path;
      const response = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json",
        Accept: "application/json", "X-Nostr-Authorization": nip98(target, text, key), ...headers }, body: text });
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    await t.test("L402 requires fresh owner authentication and a confirmed preimage before staking", async () => {
      const before = (await a.get(owner)).staked_sats;
      const challenge = await post("/paid", {}, { "X-Yield-Mode": "stake" });
      assert.equal(challenge.status, 402);
      const invoice = invoices.get(challenge.body.payment_hash)!;
      assert.ok(invoice);
      const headers = { "X-Yield-Mode": "stake", Authorization: `L402 ${challenge.body.macaroon}:${invoice.preimage}` };
      const wrong = await post("/paid", {}, headers, otherKey);
      assert.equal(wrong.status, 403);
      assert.equal((await post("/paid", {}, { ...headers, "X-Nostr-Authorization": "" })).status, 401);
      const paid = await post("/paid", {}, headers);
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      assert.equal(paid.headers.get("x-yield-mode"), "stake");
      assert.ok((await a.get(owner)).staked_sats > before);
      const credited = (await a.get(owner)).staked_sats;
      assert.equal((await post("/paid", {}, headers)).status, 429);
      assert.equal((await a.get(owner)).staked_sats, credited);
      const normal = await post("/paid", {});
      assert.equal(normal.status, 402);
      const defaultInvoice = invoices.get(normal.body.payment_hash)!;
      assert.equal((await post("/paid", {}, { Authorization: `L402 ${normal.body.macaroon}:${defaultInvoice.preimage}` })).status, 200);
      assert.equal((await a.get(owner)).staked_sats, credited, "absent header never stakes");
      const withdraw = await post("/paid", {}, { "X-Yield-Mode": "withdraw" });
      const withdrawalInvoice = invoices.get(withdraw.body.payment_hash)!;
      assert.equal((await post("/paid", {}, { "X-Yield-Mode": "withdraw",
        Authorization: `L402 ${withdraw.body.macaroon}:${withdrawalInvoice.preimage}` })).status, 200);
      assert.equal((await a.get(owner)).staked_sats, credited, "withdraw preserves explicit withdrawal behavior");
      const unused = await post("/paid", {}, { "X-Yield-Mode": "stake" });
      const unpaid = invoices.get(unused.body.payment_hash)!; unpaid.paid = false;
      assert.equal((await post("/paid", {}, { "X-Yield-Mode": "stake",
        Authorization: `L402 ${unused.body.macaroon}:${unpaid.preimage}` })).status, 402);
      assert.equal((await a.get(owner)).staked_sats, credited);
      assert.equal(executions, 3);
    });
    await t.test("payment.get_escrow authenticates signer, exact URL, body, freshness and schema", async () => {
      const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "payment.get_escrow", arguments: {} } };
      const ok = await post("/mcp", rpc);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.result.structuredContent, await a.get(owner));
      assert.equal(ok.headers.get("cache-control"), "no-store");
      assert.equal((await post("/mcp", rpc, { "X-Nostr-Authorization": "" })).status, 401);
      const stale = nip98(url + "/mcp", JSON.stringify(rpc), ownerKey, Math.floor(Date.now() / 1000) - 120);
      assert.equal((await post("/mcp", rpc, { "X-Nostr-Authorization": stale })).status, 401);
      const wrongUrl = nip98(url + "/wrong", JSON.stringify(rpc));
      assert.equal((await post("/mcp", rpc, { "X-Nostr-Authorization": wrongUrl })).status, 401);
      const wrongBody = nip98(url + "/mcp", JSON.stringify({ ...rpc, id: 2 }));
      assert.equal((await post("/mcp", rpc, { "X-Nostr-Authorization": wrongBody })).status, 401);
      const forged = JSON.parse(Buffer.from(nip98(url + "/mcp", JSON.stringify(rpc)).slice(6), "base64").toString());
      forged.sig = "00".repeat(64);
      assert.equal((await post("/mcp", rpc, { "X-Nostr-Authorization":
        `Nostr ${Buffer.from(JSON.stringify(forged)).toString("base64")}` })).status, 401);
      assert.equal((await post("/mcp", { ...rpc, params: { ...rpc.params, arguments: { pubkey: other } } })).status, 400);
      const theirs = await post("/mcp", rpc, {}, otherKey);
      assert.deepEqual(theirs.body.result.structuredContent, await a.get(other));
      const list = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
      assert.equal(list.body.result.tools.length, 17);
      assert.equal(mcpToolDefinitions.filter(tool => tool.name !== "payment.get_escrow").length, 16);
    });
    await t.test("storage failure prevents execution; a lost commit acknowledgement retries without double credit", async () => {
      let fail = true;
      const outageUrl = await worker({ ...a, async credit(receipt) {
        if (fail) throw new Error("database offline");
        await a.credit(receipt);
      } });
      const challenge = await post(outageUrl + "/paid", {}, { "X-Yield-Mode": "stake" });
      const invoice = invoices.get(challenge.body.payment_hash)!;
      const headers = { "X-Yield-Mode": "stake", Authorization: `L402 ${challenge.body.macaroon}:${invoice.preimage}` };
      const before = executions, balance = await a.get(owner);
      assert.equal((await post(outageUrl + "/paid", {}, headers)).status, 503);
      assert.equal(executions, before);
      assert.deepEqual(await a.get(owner), balance);
      fail = false;
      assert.equal((await post(outageUrl + "/paid", {}, headers)).status, 200, "outage did not consume quota");
      let lostAck = true;
      const lostUrl = await worker({ ...a, async credit(receipt) {
        await a.credit(receipt);
        if (lostAck) { lostAck = false; throw new Error("acknowledgement lost after commit"); }
      } });
      const second = await post(lostUrl + "/paid", {}, { "X-Yield-Mode": "stake" });
      const secondInvoice = invoices.get(second.body.payment_hash)!;
      const proof = { "X-Yield-Mode": "stake", Authorization: `L402 ${second.body.macaroon}:${secondInvoice.preimage}` };
      assert.equal((await post(lostUrl + "/paid", {}, proof)).status, 503);
      const once = await a.get(owner);
      assert.equal((await post(lostUrl + "/paid", {}, proof)).status, 200);
      assert.deepEqual(await a.get(owner), once);
      const readOnlyOutage = await worker({ ...a, async get() { throw new Error("offline"); } });
      assert.equal((await post(readOnlyOutage + "/mcp", { jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "payment.get_escrow", arguments: {} } })).status, 503);
    });
  } finally {
    for (const server of servers) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    fixture.release();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
});
