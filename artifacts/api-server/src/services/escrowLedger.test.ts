import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pool } from "@workspace/db";
import { readEscrowStats } from "./escrowStats";
import {
  ESCROW_GENESIS, LEGACY_ESCROW_GENESIS, readGenesisReceipt, withEscrowLedger,
  type EscrowSettlementRecord, type EscrowState,
} from "./escrowLedger";
import { GetEscrowGenesisReceiptResponse } from "@workspace/api-zod";
import { runEscrowWorker, type EscrowOperation, type EscrowLightningSettlement } from "./escrowBridge";

after(() => pool.end());

/** Settlement rows reference their ledger, so fixtures delete them first. */
async function deleteLedgerFixture(id: string) {
  await pool.query("DELETE FROM escrow_ledger_settlements WHERE ledger_id=$1", [id]);
  await pool.query("DELETE FROM escrow_ledger WHERE id=$1", [id]);
}

test("public stats aggregate confirmed tolls, preserve genesis once, and select latest execution leaf", async () => {
  const id = `escrow-stats-${randomUUID()}`;
  try {
    const empty = await readEscrowStats(pool, id);
    assert.equal(empty.total_settled_sats, 0);
    assert.equal(empty.total_contracts, 0);
    assert.equal(empty.latest_merkle_root, null);
    await pool.query("INSERT INTO escrow_ledger (id, genesis) VALUES ($1, $2::jsonb)",
      [id, JSON.stringify(ESCROW_GENESIS)]);
    const baseline = await readEscrowStats(pool, id);
    assert.equal(baseline.total_settled_sats, 24);
    assert.equal(baseline.total_contracts, 1);
    assert.equal(baseline.latest_merkle_root,
      ESCROW_GENESIS.settle_response.article_12_receipt.execution_leaf_hash);
    const append = (escrowId: string, index: number, toll: number | null) => pool.query(
      `INSERT INTO escrow_ledger_settlements
        (ledger_id, escrow_id, leaf_index, execution_leaf_hash, merkle_root,
         settled_at_strata_block, settled_at, payment_hash, toll_sats, settlement_provider)
       VALUES ($1,$2,$3,$4,$5,971342,$6,$7,$8,$9)`,
      [id, escrowId, index, index.toString().repeat(64), "f".repeat(64),
        `2026-10-20T12:0${index}:00Z`, toll === null ? null : "a".repeat(64),
        toll, toll === null ? null : "test-confirmed"],
    );
    await append("first", 1, 24);
    let stats = await readEscrowStats(pool, id);
    assert.equal(stats.total_settled_sats, 48);
    assert.equal(stats.total_contracts, 2);
    assert.equal(stats.latest_merkle_root, "1".repeat(64));
    assert.equal(stats.verified_toll_sats, stats.total_settled_sats);
    assert.equal(stats.settled_contracts, stats.total_contracts);
    // A duplicate historical index row and an unpaid execution commitment
    // must never inflate the total or replace the latest confirmed leaf.
    await append(ESCROW_GENESIS.create_response.escrow_id, 2, 24);
    await append("unpaid", 3, null);
    assert.deepEqual(await readEscrowStats(pool, id), stats);
    await append("second", 4, 17);
    stats = await readEscrowStats(pool, id);
    assert.equal(stats.total_settled_sats, 65);
    assert.equal(stats.total_contracts, 3);
    assert.equal(stats.latest_merkle_root, "4".repeat(64), "leaf hash, not aggregate tree root");
    await pool.query("UPDATE escrow_ledger SET genesis='{}'::jsonb WHERE id=$1", [id]);
    await assert.rejects(readEscrowStats(pool, id), /genesis ledger integrity/);
  } finally {
    await deleteLedgerFixture(id);
  }
});

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
    await pool.query("INSERT INTO escrow_ledger (id, genesis) VALUES ($1, $2::jsonb)",
      [id, JSON.stringify(LEGACY_ESCROW_GENESIS)]);
    assert.equal((await execute("stats")).body.verified_toll_sats, 24);
    const exported = await readGenesisReceipt(pool, id);
    assert.deepEqual(exported, ESCROW_GENESIS);
    assert.deepEqual(GetEscrowGenesisReceiptResponse.parse(exported), ESCROW_GENESIS);
    assert.equal(exported.settle_response.article_12_receipt.settled_at_strata_block, 971341);
    assert.equal(exported.settle_response.article_12_receipt.leaf_index, 0);
    assert.equal(exported.settle_response.article_12_receipt.tree_size, 1);
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
      if (row.genesis.create_response.escrow_id !== process.argv[2]
          || row.genesis.settle_response.article_12_receipt.lightning_settlement.amount_sats !== 24
          || row.state.contracts[0].status !== "SETTLED" || row.state.leaves.length !== 1) process.exitCode = 1;
      await db.end();
    `, id, ESCROW_GENESIS.create_response.escrow_id], {
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
    // Upgrade an earlier metadata-only seed while a paid ledger is populated.
    const beforeUpgrade = await pool.query("SELECT state FROM escrow_ledger WHERE id=$1", [id]);
    await pool.query("UPDATE escrow_ledger SET genesis=$2::jsonb WHERE id=$1",
      [id, JSON.stringify(LEGACY_ESCROW_GENESIS)]);
    assert.equal((await execute("stats")).body.verified_toll_sats, 24 + payment.amount_sats);
    const afterUpgrade = await pool.query("SELECT state FROM escrow_ledger WHERE id=$1", [id]);
    assert.deepEqual(afterUpgrade.rows[0].state, beforeUpgrade.rows[0].state);
    assert.deepEqual(await readGenesisReceipt(pool, id), ESCROW_GENESIS);
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
    await pool.query("UPDATE escrow_ledger SET genesis=jsonb_set(genesis, '{create_response,toll_fee_sats}', '0') WHERE id=$1", [id]);
    await assert.rejects(execute("stats"), /genesis ledger integrity/);
  } finally {
    await deleteLedgerFixture(id);
  }
});

test("settlements record the verified agent_id in PostgreSQL and commit it into the receipt leaf", async () => {
  const id = `escrow-agent-${randomUUID()}`;
  const execute = (op: EscrowOperation, body: Record<string, unknown> = {},
    payment?: EscrowLightningSettlement, agentId?: string, authentication?: "nip98") =>
    withEscrowLedger((state) => runEscrowWorker(
      op, body, state, 900000, undefined, payment, 100_000,
      `/nonexistent/escrow-fixture-${id}.sqlite3`,
      agentId === undefined ? undefined
        : { agentId, ...(authentication === undefined ? {} : { authentication }) },
    ), pool, id);
  const agentPubkey = "ab".repeat(32);
  const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest();
  try {
    await pool.query("INSERT INTO escrow_ledger (id, genesis) VALUES ($1, $2::jsonb)",
      [id, JSON.stringify(ESCROW_GENESIS)]);
    const create = async (task: string) => {
      const created = await execute("create", {
        buyer_pubkey: "11".repeat(32), worker_pubkey: "22".repeat(32),
        task_hash: task, amount_sats: 50,
      });
      assert.equal(created.status, 201);
      return { escrowId: String(created.body.escrow_id), tollSats: Number(created.body.toll_fee_sats) };
    };
    const { rows: [column] } = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name='escrow_ledger_settlements' AND column_name='is_authenticated'`);
    assert.deepEqual(column, { data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const attributedTask = "33".repeat(32);
    const { escrowId: attributed, tollSats } = await create(attributedTask);
    const unattributed = (await create("44".repeat(32))).escrowId;
    const authenticatedTask = "88".repeat(32);
    const authenticated = (await create(authenticatedTask)).escrowId;
    assert.ok(Number.isSafeInteger(tollSats) && tollSats > 0);
    const toll = (paymentHash: string): EscrowLightningSettlement => ({
      payment_hash: paymentHash, amount_sats: tollSats,
      provider: "test-confirmed", confirmed_at: "2026-10-18T12:00:00Z",
    });
    // Attribution exists only for settlements and only in the caveat grammar.
    await assert.rejects(execute("lookup", { escrow_id: attributed }, undefined, "planner-7"),
      /agent attribution/);
    await assert.rejects(execute("settle", {
      escrow_id: attributed, execution_trace: "agent trace", result_payload: "agent result",
    }, toll("55".repeat(32)), "planner 7"), /agent attribution/);
    // NIP-98 authentication qualifies only a lowercase Nostr pubkey.
    for (const agentId of ["planner-7", agentPubkey.toUpperCase()]) {
      await assert.rejects(execute("settle", {
        escrow_id: authenticated, execution_trace: "signed trace", result_payload: "signed result",
      }, toll("77".repeat(32)), agentId, "nip98"), /agent attribution/);
    }

    const settled = await execute("settle", {
      escrow_id: attributed, execution_trace: "agent trace", result_payload: "agent result",
    }, toll("55".repeat(32)), "planner-7");
    assert.equal(settled.status, 200);
    const receipt = settled.body.article_12_receipt as Record<string, unknown>;
    assert.equal(receipt.agent_id, "planner-7");
    // RFC 6962 leaf: task || H(trace) || H(result) || H({"agent_id":"planner-7"}).
    const attribution = sha256(JSON.stringify({ agent_id: "planner-7" }));
    const leaf = Buffer.concat([
      Buffer.from(attributedTask, "hex"), sha256("agent trace"), sha256("agent result"), attribution,
    ]);
    assert.equal(leaf.length, 128);
    assert.equal(receipt.execution_leaf_hash,
      sha256(Buffer.concat([Buffer.from([0]), leaf])).toString("hex"));

    const plain = await execute("settle", {
      escrow_id: unattributed, execution_trace: "plain trace", result_payload: "plain result",
    }, toll("66".repeat(32)));
    assert.equal(plain.status, 200);
    const plainReceipt = plain.body.article_12_receipt as Record<string, unknown>;
    assert.equal(Object.hasOwn(plainReceipt, "agent_id"), false);
    const plainLeaf = Buffer.concat([
      Buffer.from("44".repeat(32), "hex"), sha256("plain trace"), sha256("plain result"),
    ]);
    assert.equal(plainReceipt.execution_leaf_hash,
      sha256(Buffer.concat([Buffer.from([0]), plainLeaf])).toString("hex"));

    // A NIP-98 authenticated agent also commits its authentication mode.
    const signed = await execute("settle", {
      escrow_id: authenticated, execution_trace: "signed trace", result_payload: "signed result",
    }, toll("77".repeat(32)), agentPubkey, "nip98");
    assert.equal(signed.status, 200);
    const signedReceipt = signed.body.article_12_receipt as Record<string, unknown>;
    assert.equal(signedReceipt.agent_id, agentPubkey);
    assert.equal(signedReceipt.agent_authentication, "nip98");
    assert.equal(Object.hasOwn(receipt, "agent_authentication"), false);
    // Canonical key-sorted JSON: {"agent_authentication":"nip98","agent_id":"<pubkey>"}.
    const signedAttribution = sha256(JSON.stringify({
      agent_authentication: "nip98", agent_id: agentPubkey,
    }));
    const signedLeaf = Buffer.concat([
      Buffer.from(authenticatedTask, "hex"), sha256("signed trace"), sha256("signed result"),
      signedAttribution,
    ]);
    assert.equal(signedReceipt.execution_leaf_hash,
      sha256(Buffer.concat([Buffer.from([0]), signedLeaf])).toString("hex"));

    // bigint columns arrive as strings from the raw driver; the fixtures fit in int.
    const { rows } = await pool.query(
      `SELECT escrow_id, agent_id, is_authenticated, leaf_index, execution_leaf_hash, merkle_root,
         settled_at_strata_block::int AS settled_at_strata_block, settled_at, payment_hash,
         toll_sats::int AS toll_sats, settlement_provider
       FROM escrow_ledger_settlements WHERE ledger_id=$1 ORDER BY leaf_index`, [id]);
    assert.deepEqual(rows.map((row) => ({ ...row, settled_at: row.settled_at.toISOString() })), [
      {
        escrow_id: attributed, agent_id: "planner-7", is_authenticated: false,
        leaf_index: receipt.leaf_index,
        execution_leaf_hash: receipt.execution_leaf_hash, merkle_root: receipt.merkle_root,
        settled_at_strata_block: 900000, settled_at: new Date(String(receipt.timestamp)).toISOString(),
        payment_hash: "55".repeat(32), toll_sats: tollSats, settlement_provider: "test-confirmed",
      },
      {
        escrow_id: unattributed, agent_id: null, is_authenticated: false,
        leaf_index: plainReceipt.leaf_index,
        execution_leaf_hash: plainReceipt.execution_leaf_hash, merkle_root: plainReceipt.merkle_root,
        settled_at_strata_block: 900000, settled_at: new Date(String(plainReceipt.timestamp)).toISOString(),
        payment_hash: "66".repeat(32), toll_sats: tollSats, settlement_provider: "test-confirmed",
      },
      {
        escrow_id: authenticated, agent_id: agentPubkey, is_authenticated: true,
        leaf_index: signedReceipt.leaf_index,
        execution_leaf_hash: signedReceipt.execution_leaf_hash, merkle_root: signedReceipt.merkle_root,
        settled_at_strata_block: 900000, settled_at: new Date(String(signedReceipt.timestamp)).toISOString(),
        payment_hash: "77".repeat(32), toll_sats: tollSats, settlement_provider: "test-confirmed",
      },
    ]);

    // The restored engine re-verifies the attributed leaf from the PostgreSQL snapshot.
    const document = await execute("receipt", { escrow_id: attributed });
    assert.equal(document.status, 200);
    const verification = document.body.verification as Record<string, unknown>;
    assert.equal(verification.merkle_inclusion, true);
    assert.equal(verification.agent_attribution_hash, attribution.toString("hex"));
    assert.equal((document.body.proof as Record<string, unknown>).agent_id, "planner-7");
    const signedDocument = await execute("receipt", { escrow_id: authenticated });
    assert.equal(signedDocument.status, 200);
    assert.equal((signedDocument.body.verification as Record<string, unknown>).agent_attribution_hash,
      signedAttribution.toString("hex"));
    assert.equal((signedDocument.body.proof as Record<string, unknown>).agent_authentication, "nip98");
    assert.equal((await execute("stats")).body.verified_toll_sats, 24 + 3 * tollSats);

    // A rejected settlement records nothing, and a second settlement never duplicates the row.
    assert.equal((await execute("settle", {
      escrow_id: attributed, execution_trace: "agent trace", result_payload: "agent result",
    }, toll("55".repeat(32)), "planner-7")).status, 422);
    const count = await pool.query(
      "SELECT COUNT(*)::int AS n FROM escrow_ledger_settlements WHERE ledger_id=$1", [id]);
    assert.equal(count.rows[0].n, 3);

    // Rewriting the attributed agent in the durable snapshot fails verification.
    const { rows: [snapshot] } = await pool.query("SELECT state FROM escrow_ledger WHERE id=$1", [id]);
    const state = snapshot.state as EscrowState;
    const forged = state.leaves.find((row) => row.escrow_id === attributed)!;
    forged.receipt_json = JSON.stringify({
      ...JSON.parse(String(forged.receipt_json)), agent_id: "planner-8",
    });
    // Claiming or dropping authentication changes the committed digest too.
    const upgraded = state.leaves.find((row) => row.escrow_id === unattributed)!;
    upgraded.receipt_json = JSON.stringify({
      ...JSON.parse(String(upgraded.receipt_json)), agent_authentication: "nip98",
    });
    const downgraded = state.leaves.find((row) => row.escrow_id === authenticated)!;
    const { agent_authentication: _dropped, ...unsigned } = JSON.parse(String(downgraded.receipt_json));
    downgraded.receipt_json = JSON.stringify(unsigned);
    await pool.query("UPDATE escrow_ledger SET state=$2::jsonb WHERE id=$1", [id, JSON.stringify(state)]);
    for (const escrowId of [attributed, unattributed, authenticated]) {
      assert.equal((await execute("receipt", { escrow_id: escrowId })).status, 422);
    }
  } finally {
    await deleteLedgerFixture(id);
  }
});

test("a failed settlement record rolls back the snapshot and releases nothing", async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("INSERT INTO escrow_ledger_settlements")) throw new Error("settlement insert failed");
      return { rows: [{ state: { version: 1, contracts: [], leaves: [] }, genesis: ESCROW_GENESIS }] };
    },
    release() {},
  };
  const settlement: EscrowSettlementRecord = {
    escrowId: "11111111-1111-4111-8111-111111111111", agentId: "planner-7", isAuthenticated: false,
    leafIndex: 1,
    executionLeafHash: "a".repeat(64), merkleRoot: "b".repeat(64), settledAtStrataBlock: 900000,
    settledAt: "2026-10-18T12:00:00Z", paymentHash: null, tollSats: null, settlementProvider: null,
  };
  await assert.rejects(withEscrowLedger(async (state) => ({
    state: state!, result: { status: "SETTLED", preimage: "fixture-only" }, settlement,
  }), { connect: async () => client } as unknown as Pick<typeof pool, "connect">),
  /settlement insert failed/);
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(statements.some((statement) => statement.startsWith("UPDATE escrow_ledger SET")), false);
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
