import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pool } from "@workspace/db";
import { ESCROW_GENESIS, withEscrowLedger, type EscrowState } from "./escrowLedger";
import { runEscrowWorker, type EscrowOperation, type EscrowLightningSettlement } from "./escrowBridge";

// Real development PostgreSQL plus a fresh, secret-free Python process and a
// freshly deleted scratch directory on EVERY operation. No wallet/network calls.
test("durable escrow recovers genesis, contracts, proofs and exact totals after process restarts", async () => {
  const id = `escrow-regression-${randomUUID()}`;
  const execute = (op: EscrowOperation, body: Record<string, unknown> = {},
    payment?: EscrowLightningSettlement) =>
    withEscrowLedger((state) => runEscrowWorker(
      op, body, state, 900000, undefined, payment, 100_000,
      `/nonexistent/escrow-fixture-${id}.sqlite3`,
    ), pool, id);
  try {
    assert.equal((await execute("stats")).body.verified_toll_sats, 24);
    const created = await execute("create", {
      buyer_pubkey: "11".repeat(32), worker_pubkey: "22".repeat(32),
      task_hash: "33".repeat(32), amount_sats: 50,
    });
    assert.equal(created.status, 201);
    const escrow_id = created.body.escrow_id;
    assert.equal((await execute("lookup", { escrow_id })).body.status, "LOCKED");
    assert.equal((await execute("stats")).body.verified_toll_sats, 24);
    const payment = {
      payment_hash: "44".repeat(32), amount_sats: Number(created.body.toll_fee_sats),
      provider: "test-confirmed", confirmed_at: "2026-10-13T00:00:00Z",
    };
    const settled = await execute("settle", {
      escrow_id, execution_trace: "fixture execution", result_payload: "fixture result",
    }, payment);
    assert.equal(settled.status, 200);
    const receipt = await execute("receipt", { escrow_id });
    assert.equal(receipt.status, 200);
    assert.equal((receipt.body.verification as Record<string, unknown>).merkle_inclusion, true);
    assert.equal((await execute("stats")).body.verified_toll_sats, 24 + payment.amount_sats);
    // Independent Node process, not just a reused module or in-memory connection.
    const restarted = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import pg from "pg";
      const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const { rows } = await db.query("SELECT genesis, state FROM escrow_ledger WHERE id=$1", [process.argv[1]]);
      const row = rows[0];
      if (row.genesis.escrow_id !== process.argv[2] || row.genesis.toll_fee_sats !== 24
          || row.state.contracts[0].status !== "SETTLED" || row.state.leaves.length !== 1) process.exitCode = 1;
      await db.end();
    `, id, ESCROW_GENESIS.escrow_id], {
      cwd: new URL("../../../lib/db/", import.meta.url),
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(restarted.status, 0, "Independent process must recover the committed ledger");
    // Duplicate seed/start and attempted second settlement never double-count.
    assert.equal((await execute("settle", {
      escrow_id, execution_trace: "fixture execution", result_payload: "fixture result",
    }, payment)).status, 422);
    const snapshots = await Promise.all([execute("stats"), execute("stats"), execute("stats")]);
    assert.ok(snapshots.every((out) => out.body.verified_toll_sats === 24 + payment.amount_sats));
    const { rows } = await pool.query("SELECT genesis FROM escrow_ledger WHERE id=$1", [id]);
    assert.deepEqual(rows[0].genesis, ESCROW_GENESIS);
    // Transaction abort must not replace an already committed ledger.
    await assert.rejects(withEscrowLedger(async () => {
      throw new Error("simulated crash before commit");
    }, pool, id), /simulated crash/);
    assert.deepEqual((await execute("receipt", { escrow_id })).body, receipt.body);
    assert.equal((await execute("stats")).body.verified_toll_sats, 24 + payment.amount_sats);
    // Two independent writers must not restore the same old snapshot and lose
    // one contract. The row lock covers both engine invocation and PG commit.
    const additional = await Promise.all([1, 2].map(() => execute("create", {
      buyer_pubkey: "55".repeat(32), worker_pubkey: "66".repeat(32),
      task_hash: "77".repeat(32), amount_sats: 30,
    })));
    assert.ok(additional.every((out) => out.status === 201));
    for (const out of additional) {
      assert.equal((await execute("lookup", { escrow_id: out.body.escrow_id })).body.status, "LOCKED");
    }
    // Unpaid/synthetic settlements are preserved but never count as paid tolls.
    const unpaid = await execute("settle", {
      escrow_id: additional[0]!.body.escrow_id, execution_trace: "unpaid", result_payload: "fixture",
    });
    assert.equal(unpaid.status, 200);
    assert.equal((await execute("stats")).body.verified_toll_sats, 24 + payment.amount_sats);
    // Corrupt genesis must fail closed instead of silently overwriting history.
    await pool.query("UPDATE escrow_ledger SET genesis=jsonb_set(genesis, '{toll_fee_sats}', '0') WHERE id=$1", [id]);
    await assert.rejects(execute("stats"), /genesis ledger integrity/);
  } finally {
    await pool.query("DELETE FROM escrow_ledger WHERE id=$1", [id]);
    await pool.end();
  }
});

test("missing durable database never falls back to a local or empty ledger", async () => {
  const unavailable = { connect: async () => { throw new Error("database unavailable"); } };
  let invoked = false;
  await assert.rejects(withEscrowLedger(async () => {
    invoked = true;
    return { state: { version: 1, contracts: [], leaves: [] } as EscrowState, result: 0 };
  }, unavailable as unknown as Pick<typeof pool, "connect">), /database unavailable/);
  assert.equal(invoked, false);
});

test("commit failure never releases a settlement response", async () => {
  let rolledBack = false;
  let released = false;
  const client = {
    async query(sql: string) {
      if (sql === "COMMIT") throw new Error("commit failed");
      if (sql === "ROLLBACK") rolledBack = true;
      return { rows: [{ state: { version: 1, contracts: [], leaves: [] }, genesis: ESCROW_GENESIS }] };
    },
    release() { released = true; },
  };
  const database = { connect: async () => client };
  await assert.rejects(withEscrowLedger(async (state) => ({
    state: state!, result: { status: "SETTLED", preimage: "fixture-only" },
  }), database as unknown as Pick<typeof pool, "connect">), /commit failed/);
  assert.equal(rolledBack, true);
  assert.equal(released, true);
});
