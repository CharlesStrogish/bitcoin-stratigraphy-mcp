import assert from "node:assert/strict";
import { after, test } from "node:test";
import { finalizeEvent } from "nostr-tools";
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
} from "../helpers/credit-harness";

after(async () => {
  await pool.end();
});

async function discountedTab() {
  const h = createCreditHarness();
  try {
    const commander = identity();
    await h.seed(commander, 51);
    const base = await h.worker();
    const close = () =>
      h.request(base, {}, commander, { path: tabPath + "/close" });
    const settle = (url: string, auth: string) =>
      h.request(url, {}, commander, { path: tabPath + "/settle", auth });
    const statement = (url = base) =>
      h.request(url, undefined, commander, {
        path: FLEET_STATEMENT_PATH,
        method: "GET",
      });
    assert.equal((await h.request(base, rpc(), commander)).status, 200);
    const first = await close();
    const paid = h.invoices.get(first.body.payment_hash)!;
    paid.paid = true;
    const historicalAuth = `L402 ${first.body.macaroon}:${paid.preimage}`;
    assert.equal((await settle(base, historicalAuth)).status, 200);
    assert.equal((await h.request(base, rpc(), commander)).status, 200);
    const quote = await close();
    assert.equal(quote.status, 402);
    assert.equal(quote.body.amount_sats, 198);
    assert.equal(quote.body.yield_applied_msats, 52000);
    const invoice = h.invoices.get(quote.body.payment_hash)!;
    const auth = `L402 ${quote.body.macaroon}:${invoice.preimage}`;
    return {
      h,
      commander,
      base,
      close,
      settle,
      statement,
      quote,
      invoice,
      auth,
      historicalAuth,
    };
  } catch (error) {
    await h.cleanup();
    throw error;
  }
}

test("Commander statement is authenticated, strictly read-only, private and preserves fractional accounting", async () => {
  const s = await discountedTab();
  const { h, commander, base, statement } = s;
  try {
    const get = { path: FLEET_STATEMENT_PATH, method: "GET" };
    assert.equal(
      (await h.request(base, undefined, undefined, get)).status,
      401,
    );
    const outsider = identity();
    assert.equal((await h.request(base, undefined, outsider, get)).status, 403);
    const absent = await pool.query(
      "SELECT * FROM enterprise_credit_accounts WHERE pubkey=$1",
      [outsider.pubkey],
    );
    assert.equal(absent.rowCount, 0, "statement must not create accounts");
    assert.equal(
      (
        await h.request(base, undefined, commander, {
          ...get,
          signed: h.signed(base, tabPath, undefined, commander, "GET"),
        })
      ).status,
      401,
      "signature must bind the statement URL",
    );
    const signed = JSON.parse(
      Buffer.from(
        h
          .signed(base, FLEET_STATEMENT_PATH, undefined, commander, "GET")
          .slice(6),
        "base64",
      ).toString(),
    );
    const stale = finalizeEvent(
      {
        kind: signed.kind,
        tags: signed.tags,
        content: "",
        created_at: Math.floor(Date.now() / 1000) - 600,
      },
      commander.key,
    );
    assert.equal(
      (
        await h.request(base, undefined, commander, {
          ...get,
          signed: `Nostr ${Buffer.from(JSON.stringify(stale)).toString("base64")}`,
        })
      ).status,
      401,
    );
    const wrongMethod = h.signed(
      base,
      FLEET_STATEMENT_PATH,
      undefined,
      commander,
    );
    assert.equal(
      (
        await h.request(base, undefined, commander, {
          ...get,
          signed: wrongMethod,
        })
      ).status,
      401,
    );
    const method = await h.request(base, {}, commander, {
      path: FLEET_STATEMENT_PATH,
    });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET");
    const worker = identity();
    await h.seed(worker, 51);
    assert.equal(
      (
        await h.request(base, { add: [worker.pubkey] }, commander, {
          path: FLEET_REGISTER_PATH,
        })
      ).status,
      200,
    );
    assert.equal((await h.request(base, undefined, worker, get)).status, 403);
    assert.equal(
      (
        await h.request(base, undefined, worker, {
          ...get,
          headers: { "X-Agent-Id": commander.pubkey },
        })
      ).status,
      403,
      "Workers cannot impersonate the Commander",
    );
    const before = await pool.query(
      "SELECT * FROM enterprise_credit_accounts WHERE pubkey=$1",
      [commander.pubkey],
    );
    h.advance(20 * 60_000);
    const read = await statement();
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.deepEqual(read.body, {
      commander_pubkey: commander.pubkey,
      session_id: s.quote.body.session_id,
      state: "settlement_due",
      gross_unpaid_sats: 250,
      balance_msats: 197500,
      yield_credit_msats: 52500,
      yield_applied_msats: 52000,
      lifetime_yield_earned_msats: 52500,
      workers: [
        {
          worker_pubkey: worker.pubkey,
          spent_sats: 0,
          max_spend_limit: null,
        },
      ],
    });
    assert.equal("invoice" in read.body, false);
    assert.equal("macaroon" in read.body, false);
    assert.equal(h.invoices.size, 2);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT * FROM enterprise_credit_accounts WHERE pubkey=$1",
          [commander.pubkey],
        )
      ).rows,
      before.rows,
    );
    s.invoice.paid = true;
    assert.equal((await s.settle(base, s.auth)).status, 200);
    const final = await statement();
    assert.equal(final.body.yield_credit_msats, 42080);
    assert.equal(final.body.lifetime_yield_earned_msats, 94080);
    assert.equal(final.body.yield_applied_msats, 0);
    assert.equal(final.body.balance_msats, -42080);
    // Read after idle on an active, unfrozen tab must not close it either.
    await h.request(base, rpc(), commander);
    h.advance(20 * 60_000);
    assert.equal((await statement()).body.state, "credit_tab");
  } finally {
    await h.cleanup();
  }
});

test("expired discounted invoices release locks and retain exact discount through outage and failed replacement", async () => {
  const s = await discountedTab();
  const { h, close, statement, commander } = s;
  try {
    h.advance(3600_001);
    h.unavailable(true);
    assert.equal((await close()).status, 503);
    assert.equal((await statement()).body.yield_credit_msats, 52500);
    h.unavailable(false);
    h.failInvoice(true);
    assert.equal((await close()).status, 503);
    h.failInvoice(false);
    const replacement = await close();
    assert.equal(replacement.status, 402);
    assert.notEqual(replacement.body.payment_hash, s.quote.body.payment_hash);
    assert.equal(replacement.body.session_id, s.quote.body.session_id);
    assert.equal(replacement.body.gross_amount_sats, 250);
    assert.equal(replacement.body.amount_sats, 198);
    assert.equal(replacement.body.yield_applied_msats, 52000);
    assert.equal((await statement()).body.yield_credit_msats, 52500);
    const fresh = await h.worker(new EnterpriseCreditTabs(undefined, h.now));
    const invoice = h.invoices.get(replacement.body.payment_hash)!;
    invoice.paid = true;
    const auth = `L402 ${replacement.body.macaroon}:${invoice.preimage}`;
    assert.equal((await s.settle(fresh, auth)).status, 200);
    assert.equal((await statement(fresh)).body.yield_credit_msats, 42080);
    assert.equal((await statement()).body.lifetime_yield_earned_msats, 94080);
    // A late payment to the replaced invoice must not touch any later session.
    assert.equal((await h.request(fresh, rpc(), commander)).status, 200);
    const before = (await statement()).body;
    s.invoice.paid = true;
    assert.equal((await s.settle(fresh, s.auth)).status, 403);
    assert.equal(
      (await s.settle(fresh, s.historicalAuth)).body.status,
      "already_settled",
    );
    assert.equal((await s.settle(fresh, auth)).body.status, "already_settled");
    assert.deepEqual((await statement()).body, before);
  } finally {
    await h.cleanup();
  }
});

test("paid expired discounted invoice is not replaced and its historical credential redeems exactly once", async () => {
  const s = await discountedTab();
  try {
    s.invoice.paid = true;
    s.h.advance(3600_001);
    assert.equal((await s.close()).status, 409);
    assert.equal(s.h.invoices.size, 2);
    assert.equal((await s.statement()).body.yield_credit_msats, 52500);
    const fresh = await s.h.worker(
      new EnterpriseCreditTabs(undefined, s.h.now),
    );
    assert.equal((await s.settle(fresh, s.auth)).status, 200);
    assert.equal(
      (await s.settle(s.base, s.auth)).body.status,
      "already_settled",
    );
    assert.equal((await s.statement()).body.yield_credit_msats, 42080);
    assert.equal((await s.statement()).body.lifetime_yield_earned_msats, 94080);
  } finally {
    await s.h.cleanup();
  }
});

test("interrupted discounted settlements roll back or recover a lost commit response without duplicate yield", async () => {
  for (const failure of ["before", "after"] as const) {
    const s = await discountedTab();
    let armed = true;
    // Fault injection uses real PostgreSQL transactions. 'after' models the
    // commit succeeding while its acknowledgement is lost to the caller.
    const database = new Proxy(pool, {
      get(target, property) {
        if (property === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, field) {
                if (field === "query")
                  return async (...args: unknown[]) => {
                    if (args[0] === "COMMIT" && armed) {
                      armed = false;
                      if (failure === "after")
                        await Reflect.apply(connection.query, connection, args);
                      throw new Error(
                        `connection interrupted ${failure} commit`,
                      );
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
      const failing = new EnterpriseCreditTabs(
        createPostgresEnterpriseCreditStore(database),
        s.h.now,
      );
      const worker = await s.h.worker(failing);
      s.invoice.paid = true;
      assert.equal((await s.settle(worker, s.auth)).status, 503);
      const read = await s.statement();
      assert.equal(
        read.body.yield_credit_msats,
        failure === "before" ? 52500 : 42080,
      );
      assert.equal(read.body.gross_unpaid_sats, failure === "before" ? 250 : 0);
      assert.equal(
        read.body.lifetime_yield_earned_msats,
        failure === "before" ? 52500 : 94080,
      );
      // Another store/process must acquire the lock and recover durable state.
      const recovered = await s.h.worker(
        new EnterpriseCreditTabs(undefined, s.h.now),
      );
      const results = await Promise.all([
        s.settle(recovered, s.auth),
        s.settle(s.base, s.auth),
      ]);
      assert.ok(results.every((r) => r.status === 200));
      assert.equal(
        results.filter((r) => r.body.status === "settled").length,
        failure === "before" ? 1 : 0,
      );
      assert.equal((await s.statement()).body.yield_credit_msats, 42080);
      assert.equal(
        (await s.statement()).body.lifetime_yield_earned_msats,
        94080,
      );
      assert.equal(
        await s.h.ledger.getTotalVolume(),
        448,
        "revenue retries deduplicate",
      );
      const count = await pool.query(
        "SELECT count(*)::int AS n FROM enterprise_credit_settlements WHERE pubkey=$1 AND source='credit-tab'",
        [s.commander.pubkey],
      );
      assert.equal(count.rows[0].n, 2);
    } finally {
      await s.h.cleanup();
    }
  }
});
