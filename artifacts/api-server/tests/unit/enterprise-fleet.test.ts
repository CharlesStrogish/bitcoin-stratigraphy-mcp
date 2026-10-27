import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "@workspace/db";
import {
  createCreditHarness,
  identity,
  rpc,
  tabPath,
} from "../helpers/credit-harness";
import { FLEET_REGISTER_PATH as fleetPath } from "../../src/lib/enterprise-credit-tabs";

after(async () => {
  await pool.end();
});

test("fleet registration requires VIP body-bound Commander auth, forbids nesting/ownership theft and rejects replay", async () => {
  const h = createCreditHarness();
  try {
    const base = await h.worker();
    const commander = identity(),
      rival = identity(),
      worker = identity();
    const add = { add: [worker.pubkey] };
    assert.equal(
      (await h.request(base, add, undefined, { path: fleetPath })).status,
      401,
    );
    await h.seed(commander, 50);
    assert.equal(
      (await h.request(base, add, commander, { path: fleetPath })).status,
      403,
    );
    await h.seed(commander, 1);
    const signature = h.signed(base, fleetPath, add, commander);
    assert.equal(
      (
        await h.request(base, { remove: [worker.pubkey] }, commander, {
          path: fleetPath,
          signed: signature,
        })
      ).status,
      401,
    );
    const registered = await h.request(base, add, commander, {
      path: fleetPath,
      signed: signature,
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    assert.deepEqual(registered.body.workers, [worker.pubkey]);
    assert.equal(registered.body.commander_pubkey, commander.pubkey);
    assert.equal(
      (
        await h.request(base, add, commander, {
          path: fleetPath,
          signed: signature,
        })
      ).status,
      409,
    );
    for (const body of [
      { add: [commander.pubkey] },
      { add: ["bad-key"] },
      { add: [worker.pubkey], remove: [worker.pubkey] },
      { commander_pubkey: rival.pubkey, ...add },
      { add: null },
      {},
    ]) {
      assert.equal(
        (await h.request(base, body, commander, { path: fleetPath })).status,
        400,
        JSON.stringify(body),
      );
    }
    await h.seed(rival, 51);
    assert.equal(
      (await h.request(base, add, rival, { path: fleetPath })).status,
      409,
    );
    assert.equal(
      (
        await h.request(base, { add: [commander.pubkey] }, rival, {
          path: fleetPath,
        })
      ).status,
      409,
    );
    await h.seed(worker, 51);
    assert.equal(
      (
        await h.request(base, { add: [rival.pubkey] }, worker, {
          path: fleetPath,
        })
      ).status,
      409,
    );
    const removed = await h.request(
      base,
      { remove: [worker.pubkey] },
      commander,
      { path: fleetPath },
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.workers, []);
    assert.equal(
      (
        await h.request(base, add, commander, {
          path: fleetPath,
          signed: signature,
        })
      ).status,
      409,
      "old registration may not restore a revoked Worker",
    );
    assert.equal(
      (await h.request(base, add, rival, { path: fleetPath })).status,
      200,
    );
  } finally {
    await h.cleanup();
  }
});

test("different Worker keys and Commander share the atomic 2000-sat ceiling and Commander-only whole-tab settlement", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      b = await h.worker();
    const commander = identity(),
      workers = [identity(), identity(), identity()];
    await h.seed(commander, 51);
    assert.equal(
      (
        await h.request(a, { add: workers.map((w) => w.pubkey) }, commander, {
          path: fleetPath,
        })
      ).status,
      200,
    );
    const agents = [commander, ...workers];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.request(i % 2 ? a : b, rpc(), agents[i % agents.length]),
      ),
    );
    const diagnostics = JSON.stringify(
      results.map((r) => ({ status: r.status, error: r.body.error?.message })),
    );
    assert.equal(
      results.filter((r) => r.status === 200).length,
      8,
      diagnostics,
    );
    assert.equal(
      results.filter((r) => r.status === 402).length,
      4,
      diagnostics,
    );
    assert.equal(h.executions(), 8);
    assert.equal(h.invoices.size, 1);
    assert.equal(
      h.completions(),
      0,
      "deferred fleet work is not paid broadcast evidence",
    );
    assert.equal((await h.tabs.status(commander.pubkey)).unpaid_sats, 2000);
    for (const w of workers)
      assert.equal((await h.tabs.status(w.pubkey)).unpaid_sats, 0);
    const quote = results.find((r) => r.status === 402)!.data;
    assert.equal(quote.pubkey, commander.pubkey);
    const invoice = h.invoices.get(quote.payment_hash)!;
    assert.equal(invoice.amount, 2_000_000);
    const auth = `L402 ${quote.macaroon}:${invoice.preimage}`;
    invoice.paid = true;
    assert.equal(
      (await h.request(a, {}, workers[0], { path: tabPath + "/settle", auth }))
        .status,
      403,
    );
    const settled = await Promise.all(
      [a, b].map((url) =>
        h.request(url, {}, commander, { path: tabPath + "/settle", auth }),
      ),
    );
    assert.deepEqual(settled.map((r) => r.body.status).sort(), [
      "already_settled",
      "settled",
    ]);
    assert.equal(await h.ledger.getTotalVolume(), 2000);
    assert.equal((await h.tabs.status(commander.pubkey)).unpaid_sats, 0);
    const next = await h.request(b, rpc(), workers[0]);
    assert.equal(next.status, 200);
    assert.equal(next.headers.get("x-credit-tab-balance-sats"), "250");
    await h.request(a, {}, commander, { path: tabPath + "/settle", auth });
    assert.equal(
      (await h.tabs.status(commander.pubkey)).unpaid_sats,
      250,
      "old settlement never clears a new fleet tab",
    );
  } finally {
    await h.cleanup();
  }
});

test("Worker removal is durable across servers, preserves debt and leaves unauthorized identities on the standard lane", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      b = await h.worker();
    const commander = identity(),
      worker = identity(),
      outsider = identity();
    await h.seed(commander, 51);
    await h.request(a, { add: [worker.pubkey] }, commander, {
      path: fleetPath,
    });
    const body = rpc();
    const signature = h.signed(a, "/mcp", body, worker);
    const first = await h.request(a, body, worker, {
      signed: signature,
      headers: { "X-Agent-Lightning-Address": "attacker@example.com" },
    });
    assert.equal(first.status, 200);
    // Same URL must be used for the replay's NIP-98 binding.
    assert.equal(
      (await h.request(a, body, worker, { signed: signature })).status,
      409,
    );
    assert.equal((await h.request(b, rpc(), outsider)).status, 400);
    await h.request(b, { remove: [worker.pubkey] }, commander, {
      path: fleetPath,
    });
    const revoked = await h.request(a, rpc(), worker);
    assert.equal(revoked.status, 400);
    assert.ok(revoked.data.proof_of_work);
    assert.equal((await h.tabs.status(commander.pubkey)).unpaid_sats, 250);
    const closed = await h.request(a, {}, commander, {
      path: tabPath + "/close",
    });
    const allocation = await h.economicStore.transaction("read", (tx) =>
      tx.invoice(closed.data.payment_hash),
    );
    assert.equal(allocation!.buyer, commander.pubkey);
    assert.equal(
      allocation!.kickback_msats,
      "0",
      "Worker payout headers cannot change master routing",
    );
  } finally {
    await h.cleanup();
  }
});

test("simultaneous fleet ownership claims and partial conflicting updates remain atomic", async () => {
  const h = createCreditHarness();
  try {
    const a = await h.worker(),
      b = await h.worker();
    const commanders = [identity(), identity()],
      worker = identity(),
      extra = identity();
    for (const c of commanders) await h.seed(c, 51);
    const results = await Promise.all(
      commanders.map((c, i) =>
        h.request(i ? b : a, { add: [worker.pubkey] }, c, { path: fleetPath }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = commanders[results.findIndex((r) => r.status === 200)]!;
    const loser = commanders.find((c) => c !== winner)!;
    assert.equal(
      (
        await h.request(a, { add: [extra.pubkey, worker.pubkey] }, loser, {
          path: fleetPath,
        })
      ).status,
      409,
    );
    const rows = await pool.query(
      "SELECT worker_pubkey FROM enterprise_credit_fleet WHERE commander_pubkey=$1",
      [loser.pubkey],
    );
    assert.equal(
      rows.rows.length,
      0,
      "conflicting batch must not partially authorize",
    );
    await h.request(b, rpc(), worker);
    assert.equal((await h.tabs.status(winner.pubkey)).unpaid_sats, 250);
    assert.equal((await h.tabs.status(loser.pubkey)).unpaid_sats, 0);
  } finally {
    await h.cleanup();
  }
});
