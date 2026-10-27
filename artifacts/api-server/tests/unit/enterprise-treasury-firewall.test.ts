import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "@workspace/db";
import {
  EnterpriseCreditTabs,
  FLEET_REGISTER_PATH,
  FLEET_STATEMENT_PATH,
} from "../../src/lib/enterprise-credit-tabs";
import { createPostgresEnterpriseCreditStore } from "../../src/lib/enterprise-credit-store";
import {
  createCreditHarness,
  identity,
  rpc,
  tabPath,
  type Identity,
} from "../helpers/credit-harness";

after(async () => {
  await pool.end();
});

async function fleet() {
  const h = createCreditHarness();
  try {
    const commander = identity(),
      worker = identity(),
      sibling = identity();
    await h.seed(commander, 51);
    const a = await h.worker(),
      b = await h.worker();
    const register = (body: unknown, signer = commander) =>
      h.request(a, body, signer, { path: FLEET_REGISTER_PATH });
    const statement = () =>
      h.request(a, undefined, commander, {
        path: FLEET_STATEMENT_PATH,
        method: "GET",
      });
    const row = async (who: Identity) => {
      const result = await statement();
      assert.equal(result.status, 200);
      return result.body.workers.find(
        (entry: { worker_pubkey: string }) =>
          entry.worker_pubkey === who.pubkey,
      );
    };
    return { h, commander, worker, sibling, a, b, register, statement, row };
  } catch (error) {
    await h.cleanup();
    throw error;
  }
}

test("concurrent calls stop a capped Worker at its limit while a sibling keeps executing", async () => {
  const f = await fleet();
  try {
    assert.equal(
      (
        await f.register({
          add: [
            { pubkey: f.worker.pubkey, max_spend_limit: 250 },
            { pubkey: f.sibling.pubkey, max_spend_limit: 500 },
          ],
        })
      ).status,
      200,
    );
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        f.h.request(i % 2 ? f.a : f.b, rpc(), f.worker),
      ),
    );
    assert.equal(attempts.filter((r) => r.status === 200).length, 1);
    assert.equal(attempts.filter((r) => r.status === 403).length, 5);
    assert.ok(
      attempts
        .filter((r) => r.status === 403)
        .every((r) =>
          JSON.stringify(r.body).includes("Worker spend limit exceeded"),
        ),
    );
    assert.equal(f.h.invoices.size, 0, "denial must not create an invoice");
    const before = (await f.statement()).body;
    assert.equal((await f.h.request(f.b, rpc(), f.worker)).status, 403);
    assert.deepEqual(
      (await f.statement()).body,
      before,
      "denial leaves balances untouched",
    );
    assert.equal((await f.h.request(f.b, rpc(), f.sibling)).status, 200);
    assert.equal((await f.h.request(f.a, rpc(), f.sibling)).status, 200);
    assert.equal((await f.h.request(f.b, rpc(), f.sibling)).status, 403);
    assert.deepEqual(await f.row(f.worker), {
      worker_pubkey: f.worker.pubkey,
      spent_sats: 250,
      max_spend_limit: 250,
    });
    assert.deepEqual(await f.row(f.sibling), {
      worker_pubkey: f.sibling.pubkey,
      spent_sats: 500,
      max_spend_limit: 500,
    });
    const statement = (await f.statement()).body;
    assert.equal(statement.gross_unpaid_sats, 750);
    assert.equal(statement.state, "credit_tab");
    assert.equal(f.h.executions(), 3);
    const charges = await pool.query(
      `SELECT worker_pubkey, SUM(amount_sats)::int AS amount
       FROM enterprise_credit_charges WHERE pubkey=$1 GROUP BY worker_pubkey`,
      [f.commander.pubkey],
    );
    assert.equal(charges.rows.length, 2);
    assert.equal(
      charges.rows.find((r) => r.worker_pubkey === f.worker.pubkey).amount,
      250,
    );
  } finally {
    await f.h.cleanup();
  }
});

test("worker spend survives settlement, limit updates, process replacement and remove/re-add", async () => {
  const f = await fleet();
  try {
    await f.register({
      add: [{ pubkey: f.worker.pubkey, max_spend_limit: 750 }],
    });
    assert.equal((await f.h.request(f.a, rpc(), f.worker)).status, 200);
    const close = await f.h.request(f.a, {}, f.commander, {
      path: tabPath + "/close",
    });
    const invoice = f.h.invoices.get(close.body.payment_hash)!;
    invoice.paid = true;
    assert.equal(
      (
        await f.h.request(f.b, {}, f.commander, {
          path: tabPath + "/settle",
          auth: `L402 ${close.body.macaroon}:${invoice.preimage}`,
        })
      ).status,
      200,
    );
    assert.equal((await f.row(f.worker)).spent_sats, 250);
    assert.equal((await f.statement()).body.yield_credit_msats, 52500);
    await f.register({
      add: [{ pubkey: f.worker.pubkey, max_spend_limit: 300 }],
    });
    const frozen = (await f.statement()).body;
    assert.equal(
      (await f.h.request(f.b, rpc(), f.worker)).status,
      403,
      "full next toll is checked even before the counter reaches the cap",
    );
    assert.deepEqual((await f.statement()).body, frozen);
    await f.register({ add: [f.worker.pubkey] });
    assert.equal(
      (await f.row(f.worker)).max_spend_limit,
      300,
      "legacy re-registration cannot silently erase a limit",
    );
    await f.register({ remove: [f.worker.pubkey] });
    assert.equal((await f.statement()).body.workers.length, 0);
    await f.register({
      add: [{ pubkey: f.worker.pubkey, max_spend_limit: 400 }],
    });
    assert.equal(
      (await f.row(f.worker)).spent_sats,
      250,
      "re-add restores cumulative attributed spend rather than zeroing it",
    );
    const restarted = await f.h.worker(new EnterpriseCreditTabs());
    assert.equal((await f.h.request(restarted, rpc(), f.worker)).status, 403);
    await f.register({
      add: [{ pubkey: f.worker.pubkey, max_spend_limit: 500 }],
    });
    assert.equal((await f.h.request(restarted, rpc(), f.worker)).status, 200);
    assert.equal((await f.row(f.worker)).spent_sats, 500);
    assert.equal((await f.h.request(restarted, rpc(), f.worker)).status, 403);
    // A Commander may explicitly lift a cap; omission alone never lifts it.
    await f.register({
      add: [{ pubkey: f.worker.pubkey, max_spend_limit: null }],
    });
    assert.equal((await f.h.request(restarted, rpc(), f.worker)).status, 200);
    assert.equal((await f.row(f.worker)).spent_sats, 750);
    assert.equal((await f.row(f.worker)).max_spend_limit, null);
  } finally {
    await f.h.cleanup();
  }
});

test("only body-bound Commander auth can set valid whole-sat limits, including zero", async () => {
  const f = await fleet();
  try {
    const good = { add: [{ pubkey: f.worker.pubkey, max_spend_limit: 250 }] };
    const signature = f.h.signed(f.a, FLEET_REGISTER_PATH, good, f.commander);
    assert.equal(
      (
        await f.h.request(
          f.a,
          {
            add: [{ pubkey: f.worker.pubkey, max_spend_limit: 1000 }],
          },
          f.commander,
          { path: FLEET_REGISTER_PATH, signed: signature },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.register(
          {
            add: [{ pubkey: f.sibling.pubkey, max_spend_limit: 250 }],
          },
          f.worker,
        )
      ).status,
      403,
    );
    for (const limit of [-1, 0.5, "250", Number.MAX_SAFE_INTEGER + 1, {}]) {
      assert.equal(
        (
          await f.register({
            add: [{ pubkey: f.worker.pubkey, max_spend_limit: limit }],
          })
        ).status,
        400,
        `invalid limit ${JSON.stringify(limit)}`,
      );
    }
    assert.equal(
      (
        await f.register({
          add: [
            { pubkey: f.worker.pubkey, max_spend_limit: 0 },
            f.sibling.pubkey,
          ],
        })
      ).status,
      200,
    );
    assert.equal((await f.h.request(f.a, rpc(), f.worker)).status, 403);
    assert.equal((await f.h.request(f.b, rpc(), f.sibling)).status, 200);
    assert.deepEqual(await f.row(f.worker), {
      worker_pubkey: f.worker.pubkey,
      spent_sats: 0,
      max_spend_limit: 0,
    });
    assert.equal((await f.row(f.sibling)).max_spend_limit, null);
    const signed = f.h.signed(f.a, FLEET_REGISTER_PATH, good, f.commander);
    assert.equal(
      (
        await f.h.request(f.a, good, f.commander, {
          path: FLEET_REGISTER_PATH,
          signed,
        })
      ).status,
      200,
    );
    await f.register({
      add: [{ pubkey: f.worker.pubkey, max_spend_limit: 0 }],
    });
    assert.equal(
      (
        await f.h.request(f.a, good, f.commander, {
          path: FLEET_REGISTER_PATH,
          signed,
        })
      ).status,
      409,
      "replay cannot restore an older permissive limit",
    );
    assert.equal((await f.row(f.worker)).max_spend_limit, 0);
  } finally {
    await f.h.cleanup();
  }
});

test("admission keeps the existing round-trip budget and atomically rolls back or deduplicates Worker spend", async () => {
  const f = await fleet();
  const queries: string[] = [];
  let failUpdate = false;
  const database = new Proxy(pool, {
    get(target, property) {
      if (property === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, field) {
              if (field === "query")
                return async (...args: unknown[]) => {
                  const sql = String(args[0]);
                  queries.push(sql);
                  if (
                    failUpdate &&
                    sql.startsWith("UPDATE enterprise_credit_accounts")
                  ) {
                    failUpdate = false;
                    throw new Error("interrupted account commit");
                  }
                  return Reflect.apply(connection.query, connection, args);
                };
              const value = Reflect.get(connection, field);
              return typeof value === "function"
                ? value.bind(connection)
                : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await f.register({
      add: [{ pubkey: f.worker.pubkey, max_spend_limit: 500 }],
    });
    const measured = await f.h.worker(
      new EnterpriseCreditTabs(createPostgresEnterpriseCreditStore(database)),
    );
    const body = rpc(),
      signature = f.h.signed(measured, "/mcp", body, f.worker);
    failUpdate = true;
    assert.equal(
      (await f.h.request(measured, body, f.worker, { signed: signature }))
        .status,
      503,
    );
    assert.equal((await f.row(f.worker)).spent_sats, 0);
    assert.equal((await f.statement()).body.gross_unpaid_sats, 0);
    assert.equal(f.h.executions(), 0);
    queries.length = 0;
    assert.equal(
      (await f.h.request(measured, body, f.worker, { signed: signature }))
        .status,
      200,
    );
    assert.equal(queries.length, 9, "no extra admission database round trips");
    assert.equal(
      queries.filter((sql) =>
        /FROM enterprise_credit_fleet WHERE worker_pubkey=\$1/.test(sql),
      ).length,
      2,
    );
    assert.ok(
      queries.every((sql) => !/SUM\(/i.test(sql)),
      "no history aggregation on the hot path",
    );
    assert.equal(
      (await f.h.request(measured, body, f.worker, { signed: signature }))
        .status,
      409,
    );
    assert.equal((await f.row(f.worker)).spent_sats, 250);
    assert.equal((await f.statement()).body.gross_unpaid_sats, 250);
    assert.equal(f.h.executions(), 1);
  } finally {
    await f.h.cleanup();
  }
});
