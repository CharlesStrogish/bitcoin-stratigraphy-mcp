import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "@workspace/db";
import {
  createCreditHarness,
  identity,
  rpc,
  sha,
  solve,
  tabPath,
} from "../helpers/credit-harness";
import { EnterpriseCreditTabs } from "../../src/lib/enterprise-credit-tabs";
import { createSubscriptionMacaroon } from "../../src/lib/subscription-pass";

after(async () => {
  await pool.end();
});
test("50 paid invoices stay standard; the 51st verified invoice opens a shared credit tab, without changing Hashcash", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      b = await h.worker(),
      agent = identity();
    await h.seed(agent, 50);
    const body = rpc();
    const compute = await h.request(a, body, agent);
    assert.equal(compute.status, 400, JSON.stringify(compute.body));
    assert.equal(compute.data.proof_of_work.difficulty, 3);
    assert.equal(h.invoices.size, 0);
    const invoice = await h.request(a, body, agent, {
      headers: solve(compute.data.proof_of_work.challenge),
    });
    assert.equal(invoice.status, 402, JSON.stringify(invoice.body));
    const issued = h.invoices.get(invoice.data.payment_hash)!;
    assert.ok(issued);
    const authorization = `L402 ${invoice.data.macaroon}:${issued.preimage}`;
    const unpaid = await h.request(a, body, agent, { auth: authorization });
    assert.notEqual(unpaid.status, 200);
    assert.equal((await h.tabs.status(agent.pubkey)).trust_score, 50);
    issued.paid = true;
    const paid = await h.request(a, body, agent, { auth: authorization });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.result?.isError, undefined);
    assert.equal((await h.tabs.status(agent.pubkey)).trust_score, 51);
    await h.request(a, body, agent, { auth: authorization });
    assert.equal(
      (await h.tabs.status(agent.pubkey)).trust_score,
      51,
      "one invoice counts once even on replay",
    );
    const count = h.invoices.size;
    const credited = await h.request(b, rpc(), agent);
    assert.equal(credited.status, 200, JSON.stringify(credited.body));
    assert.equal(credited.headers.get("x-credit-tab-balance-sats"), "250");
    assert.equal(
      h.invoices.size,
      count,
      "no upfront invoice for eligible execution",
    );
    assert.equal(
      h.completions(),
      1,
      "deferred execution never masquerades as a paid broadcast",
    );
    assert.equal(
      await h.ledger.getTotalVolume(),
      250,
      "debt is not received revenue",
    );
    const anonymous = await h.request(b, rpc());
    assert.equal(anonymous.status, 400);
    assert.equal(anonymous.data.proof_of_work.difficulty, 3);
  } finally {
    await h.cleanup();
  }
});

test("credit charges serialize across workers, stop at 2000 sats, settle once and preserve 79/21", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      b = await h.worker(),
      agent = identity();
    await h.seed(agent, 51);
    const payout = {
      "X-Agent-Lightning-Address": "agent@example.com",
      "X-Parent-Agent-LNURL": "parent@example.com",
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.request(i % 2 ? a : b, rpc(), agent, { headers: payout }),
      ),
    );
    assert.equal(
      results.filter((r) => r.status === 200).length,
      8,
      JSON.stringify(results.map((r) => r.body)),
    );
    assert.equal(results.filter((r) => r.status === 402).length, 4);
    assert.equal(
      h.invoices.size,
      1,
      "concurrent cap requests share a single frozen-tab invoice",
    );
    assert.equal(
      h.executions(),
      8,
      "repayment responses must never fall through to tool execution",
    );
    assert.ok(
      results
        .filter((r) => r.status === 402)
        .every((r) => !r.headers.has("PAYMENT-REQUIRED")),
      "Lightning tab repayment must not advertise a per-tool x402 price",
    );
    assert.equal((await h.tabs.status(agent.pubkey)).unpaid_sats, 2000);
    assert.equal(await h.ledger.getTotalVolume(), 0);
    const quote = results.find((r) => r.status === 402)!.data;
    const invoice = h.invoices.get(quote.payment_hash)!;
    assert.equal(invoice.amount, 2_000_000);
    const allocation = await h.economicStore.transaction("read", (tx) =>
      tx.invoice(quote.payment_hash),
    );
    assert.equal(allocation!.kickback_msats, "420000");
    assert.equal(allocation!.direct_kickback_msats, "280000");
    assert.equal(allocation!.parent_kickback_msats, "140000");
    assert.equal(2_000_000 - Number(allocation!.kickback_msats), 1_580_000);
    const auth = `L402 ${quote.macaroon}:${invoice.preimage}`;
    const badProof = await h.request(a, {}, agent, {
      path: tabPath + "/settle",
      auth: `L402 ${quote.macaroon}:${"00".repeat(32)}`,
    });
    assert.equal(badProof.status, 403);
    const unpaid = await h.request(b, {}, agent, {
      path: tabPath + "/settle",
      auth,
    });
    assert.equal(unpaid.status, 409);
    h.unavailable(true);
    assert.equal(
      (await h.request(a, {}, agent, { path: tabPath + "/settle", auth }))
        .status,
      503,
    );
    h.unavailable(false);
    assert.equal((await h.tabs.status(agent.pubkey)).unpaid_sats, 2000);
    invoice.paid = true;
    invoice.amount -= 1000;
    assert.equal(
      (await h.request(a, {}, agent, { path: tabPath + "/settle", auth }))
        .status,
      409,
      "partial payment cannot clear the full frozen tab",
    );
    invoice.amount += 1000;
    const originalRecord = h.ledger.record;
    h.ledger.record = async () => {
      throw new Error("revenue storage offline");
    };
    assert.equal(
      (await h.request(a, {}, agent, { path: tabPath + "/settle", auth }))
        .status,
      503,
    );
    assert.equal(
      (await h.tabs.status(agent.pubkey)).unpaid_sats,
      2000,
      "ledger failure cannot forgive debt",
    );
    h.ledger.record = originalRecord;
    const settlements = await Promise.all(
      [a, b].map((url) =>
        h.request(url, {}, agent, { path: tabPath + "/settle", auth }),
      ),
    );
    assert.deepEqual(
      settlements.map((r) => r.status),
      [200, 200],
      JSON.stringify(settlements),
    );
    assert.deepEqual(settlements.map((r) => r.body.status).sort(), [
      "already_settled",
      "settled",
    ]);
    assert.equal(await h.ledger.getTotalVolume(), 2000);
    assert.equal((await h.tabs.status(agent.pubkey)).unpaid_sats, 0);
    const stored = await pool.query(
      "SELECT merchant_msats,allocation_pool_msats FROM enterprise_credit_settlements WHERE payment_hash=$1",
      [quote.payment_hash],
    );
    assert.deepEqual(stored.rows[0], {
      merchant_msats: 1_580_000,
      allocation_pool_msats: 420_000,
    });
    assert.equal((await h.request(b, rpc(), agent)).status, 200);
    assert.equal(
      (await h.request(a, {}, agent, { path: tabPath + "/settle", auth })).body
        .status,
      "already_settled",
    );
    assert.equal(
      (await h.tabs.status(agent.pubkey)).unpaid_sats,
      250,
      "old payment cannot clear new debt",
    );
    assert.notEqual(
      (await h.request(a, rpc(), agent, { auth })).status,
      200,
      "tab macro cannot execute tools",
    );
  } finally {
    await h.cleanup();
  }
});

test("session close and idle timeout freeze the whole tab; wrong identities and replayed requests fail closed", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      b = await h.worker(),
      agent = identity(),
      impostor = identity();
    await h.seed(agent, 51);
    const body = rpc();
    const signature = h.signed(a, "/mcp", body, agent);
    const first = await h.request(a, body, agent, { signed: signature });
    assert.equal(first.status, 200);
    assert.equal(
      (await h.request(a, rpc(), agent, { signed: signature })).status,
      401,
      "a signature for different body bytes cannot authorize credit",
    );
    // URL is part of NIP-98. Replay on the original worker must never run again.
    assert.equal(
      (await h.request(a, body, agent, { signed: signature })).status,
      409,
    );
    assert.equal((await h.tabs.status(agent.pubkey)).unpaid_sats, 250);
    const spoof = await h.request(b, rpc(), impostor, {
      headers: { "X-Agent-Id": agent.pubkey },
    });
    assert.notEqual(spoof.status, 200);
    assert.equal(
      (
        await h.request(a, undefined, undefined, {
          path: tabPath,
          method: "GET",
        })
      ).status,
      401,
    );
    const state = await h.request(a, undefined, agent, {
      path: tabPath,
      method: "GET",
    });
    assert.equal(state.body.trust_score, 51);
    const closed = await h.request(a, {}, agent, { path: tabPath + "/close" });
    assert.equal(closed.status, 402);
    const invoice = h.invoices.get(closed.body.payment_hash)!;
    const auth = `L402 ${closed.body.macaroon}:${invoice.preimage}`;
    invoice.paid = true;
    assert.equal(
      (await h.request(b, {}, impostor, { path: tabPath + "/settle", auth }))
        .status,
      403,
    );
    assert.equal((await h.request(b, rpc(), agent)).status, 402);
    assert.equal(
      (await h.request(b, {}, agent, { path: tabPath + "/settle", auth }))
        .status,
      200,
    );
    assert.equal((await h.request(a, rpc(), agent)).status, 200);
    h.advance(15 * 60_000);
    assert.equal(
      (await h.request(a, rpc(), agent)).status,
      402,
      "idle session must settle before new credit",
    );
    assert.equal((await h.tabs.status(agent.pubkey)).unpaid_sats, 250);
    assert.equal(
      (await h.request(a, rpc(), agent, { path: "/invoice/request" })).status,
      400,
      "invoice-only alias retains the original Hashcash gate and never executes credit calls",
    );
  } finally {
    await h.cleanup();
  }
});

test("paid history is unique, authenticated historical invoices seed trust, and tab state survives worker replacement", async () => {
  const h = createCreditHarness();
  try {
    const agent = identity(),
      other = identity();
    await h.seed(agent, 1);
    const paymentHash = sha("one-" + agent.pubkey);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        h.tabs.recordPaid(agent.pubkey, "credit-test", paymentHash, 250),
      ),
    );
    assert.equal((await h.tabs.status(agent.pubkey)).trust_score, 2);
    await assert.rejects(
      h.tabs.recordPaid(other.pubkey, "credit-test", paymentHash, 250),
    );
    const historic = identity();
    // Register cleanup ownership without creating its credit account yet.
    h.signed("http://localhost", "/", {}, historic);
    const hashes = Array.from({ length: 51 }, (_, i) =>
      sha(historic.pubkey + i),
    );
    try {
      await pool.query(
        `INSERT INTO enterprise_routing_invoices(payment_hash,payload)
        SELECT value,jsonb_build_object('buyer',$2::text,'provider','credit-test','amount_msats','250000','settled_at',now()::text)
        FROM unnest($1::text[]) value`,
        [hashes, historic.pubkey],
      );
      const a = await h.worker();
      assert.equal((await h.tabs.status(historic.pubkey)).trust_score, 51);
      assert.equal((await h.request(a, rpc(), historic)).status, 200);
      const replacement = await h.worker();
      assert.equal(
        (await h.request(replacement, rpc(), historic)).headers.get(
          "x-credit-tab-balance-sats",
        ),
        "500",
      );
    } finally {
      await pool.query(
        "DELETE FROM enterprise_routing_invoices WHERE payment_hash=ANY($1::text[])",
        [hashes],
      );
    }
  } finally {
    await h.cleanup();
  }
});

test("pipeline debt charges its exact sum; partial work stays owed and closes as one macro-invoice", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      agent = identity();
    await h.seed(agent, 51);
    const body = rpc("tools/pipeline", {
      calls: [
        {
          jsonrpc: "2.0",
          id: "a",
          method: "tools/call",
          params: { name: "mesh.get_status", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: "b",
          method: "tools/call",
          params: { name: "mesh.get_status", arguments: {} },
        },
      ],
    });
    const completed = await h.request(a, body, agent);
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.result.status, "completed");
    assert.equal(
      completed.body.result.receipt.amount_sats,
      0,
      "unpaid work is not a paid receipt or broadcast",
    );
    assert.equal(completed.body.result.receipt.deferred_amount_sats, 500);
    assert.equal((await h.tabs.status(agent.pubkey)).unpaid_sats, 500);
    assert.equal(h.invoices.size, 0);
    assert.equal(
      completed.body.result.receipt.payload?.payment_hash ??
        completed.body.result.receipt.payment_hash ??
        null,
      null,
    );
    const close = await h.request(a, {}, agent, { path: tabPath + "/close" });
    assert.equal(close.body.amount_sats, 500);
    const failedAgent = identity();
    await h.seed(failedAgent, 51);
    const failingWorker = await h.worker(undefined, async () => {
      throw new Error("primary backend down");
    });
    const failed = await h.request(
      failingWorker,
      rpc("tools/pipeline", {
        calls: [
          {
            jsonrpc: "2.0",
            id: "first",
            method: "tools/call",
            params: { name: "mesh.get_status", arguments: {} },
          },
          {
            jsonrpc: "2.0",
            id: "second",
            method: "tools/call",
            params: {
              name: "stratigraphy.get_digest",
              arguments: { target: "latest" },
            },
          },
        ],
      }),
      failedAgent,
    );
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.result.status, "failed");
    assert.equal(
      (await h.tabs.status(failedAgent.pubkey)).unpaid_sats,
      500,
      "admission toll remains owed for partial execution",
    );
  } finally {
    await h.cleanup();
  }
});

test("durable admission failure does not execute a tool or use a wallet; failed invoice creation preserves closed debt", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      agent = identity();
    await h.seed(agent, 51);
    assert.equal((await h.request(a, rpc(), agent)).status, 200);
    h.failInvoice(true);
    assert.equal(
      (await h.request(a, {}, agent, { path: tabPath + "/close" })).status,
      503,
    );
    assert.equal((await h.tabs.status(agent.pubkey)).state, "settlement_due");
    assert.equal((await h.request(a, rpc(), agent)).status, 503);
    assert.equal((await h.tabs.status(agent.pubkey)).unpaid_sats, 250);
    h.failInvoice(false);
    assert.equal(
      (await h.request(a, {}, agent, { path: tabPath + "/close" })).status,
      402,
    );
    // Compile-time/runtime coverage of the middleware's injected store outage.
    const broken = new EnterpriseCreditTabs({
      transaction: async () => {
        throw new Error("database down");
      },
    });
    const brokenWorker = await h.worker(broken);
    const count = h.invoices.size;
    assert.equal((await h.request(brokenWorker, rpc(), agent)).status, 503);
    assert.equal(
      h.invoices.size,
      count,
      "database outage cannot generate an invoice or admit a tool",
    );
    // Old unrelated macaroons are not tab repayment capabilities.
    const unrelated = createSubscriptionMacaroon({
      secret: "enterprise-credit-tests",
      paymentHash: sha(agent.pubkey),
      tier: "1-day",
      validUntil: Math.floor(Date.now() / 1000) + 3600,
    });
    await assert.rejects(
      h.tabs.settle(
        agent.pubkey,
        `L402 ${unrelated}:${"00".repeat(32)}`,
        h.router,
        "enterprise-credit-tests",
      ),
    );
  } finally {
    await h.cleanup();
  }
});
