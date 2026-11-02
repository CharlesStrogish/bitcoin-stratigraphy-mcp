import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createEnterpriseWebhookDispatcher,
  type EnterpriseSettlementNotice,
} from "../../src/services/enterprise-webhook";
import { createPostgresRevenueLedger } from "../../src/services/postgres-ledger";
import { recordRevenueWithRetry, type RevenueLedgerEntry } from "../../src/services/ledger";

const notice: EnterpriseSettlementNotice = {
  transaction_id: "synthetic-ledger-id",
  satoshis_captured: 250,
  timestamp: "2026-11-02T15:00:00.000Z",
};
const endpoint = "https://corporate-monitor.invalid/incoming";
const preimage = "02".repeat(32);
const entry: RevenueLedgerEntry = {
  id: notice.transaction_id,
  timestamp: notice.timestamp,
  satsReceived: notice.satoshis_captured,
  channel: "L402",
  requestKind: "stratigraphy",
  preimage,
  paymentHash: createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex"),
  clientIdentifier: "synthetic-private-client",
};

function database(query: () => Promise<Array<{ id: string }>>) {
  return {
    async query<Row = Record<string, unknown>>() {
      return { rows: await query() as Row[] };
    },
  };
}

test("unset or invalid webhook configuration never sends or throws", async () => {
  let requests = 0;
  for (const url of [undefined, "", "not a URL", "file:///tmp/private", "https://user:password@example.invalid"]) {
    const dispatcher = createEnterpriseWebhookDispatcher({
      getUrl: () => url,
      fetch: async () => { requests++; return new Response(); },
    });
    assert.doesNotThrow(() => dispatcher.dispatch(notice));
    await nextTurn();
    assert.equal(dispatcher.inFlight, 0);
  }
  const broken = createEnterpriseWebhookDispatcher({
    getUrl: () => { throw new Error("secret configuration failure"); },
  });
  assert.doesNotThrow(() => broken.dispatch(notice));
  assert.equal(broken.inFlight, 0);
  assert.equal(requests, 0);
});

test("dispatch is deferred, snapshots input, and sends exactly the four public fields", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const dispatcher = createEnterpriseWebhookDispatcher({
    getUrl: () => endpoint,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("body to discard");
    },
  });
  const input = { ...notice, macaroon: "never-send", preimage, operator: "never-send" };
  assert.equal(dispatcher.dispatch(input), undefined);
  assert.equal(requests.length, 0, "fetch cannot run on the settlement call stack");
  input.satoshis_captured = 999;
  input.transaction_id = "mutated";
  await nextTurn();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, endpoint);
  const init = requests[0].init!;
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(init.body)), {
    ...notice, yield_distributed: 52.5,
  });
  assert.equal(dispatcher.inFlight, 0);
});

test("network rejection, synchronous fetch errors and receiver failures are swallowed without retry", async () => {
  for (const fetchImpl of [
    (() => { throw new Error("sensitive sync transport error"); }) as typeof fetch,
    (async () => { throw new Error("sensitive network error"); }) as typeof fetch,
    (async () => new Response("sensitive receiver body", { status: 500 })) as typeof fetch,
  ]) {
    let calls = 0;
    const dispatcher = createEnterpriseWebhookDispatcher({
      getUrl: () => endpoint,
      fetch: (...args) => { calls++; return fetchImpl(...args); },
    });
    dispatcher.dispatch(notice);
    await nextTurn();
    assert.equal(calls, 1);
    assert.equal(dispatcher.inFlight, 0);
  }
});

test("timeouts abort hung requests and free capacity even if a mocked transport ignores abort", async () => {
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const dispatcher = createEnterpriseWebhookDispatcher({
    getUrl: () => endpoint,
    timeoutMs: 5,
    maxInFlight: 1,
    fetch: async (_url, init) => {
      calls++;
      signal = init?.signal;
      if (calls === 1) return new Promise<Response>(() => {});
      return new Response();
    },
  });
  dispatcher.dispatch(notice);
  await nextTurn();
  await delay(30);
  assert.equal(signal?.aborted, true);
  assert.equal(dispatcher.inFlight, 0);
  dispatcher.dispatch(notice);
  await nextTurn();
  assert.equal(calls, 2);
  assert.equal(dispatcher.inFlight, 0);
});

test("scheduled and in-flight delivery are bounded with no accumulating queue", async () => {
  const finish: Array<(response: Response) => void> = [];
  const dispatcher = createEnterpriseWebhookDispatcher({
    getUrl: () => endpoint,
    maxInFlight: 2,
    fetch: async () => new Promise<Response>(resolve => finish.push(resolve)),
  });
  for (let i = 0; i < 1000; i++) dispatcher.dispatch(notice);
  assert.equal(dispatcher.inFlight, 2);
  await nextTurn();
  assert.equal(finish.length, 2);
  for (const resolve of finish) resolve(new Response());
  await nextTurn();
  assert.equal(dispatcher.inFlight, 0);
});

test("ledger dispatches only after a committed new L402 row, never duplicates or NIP-90", async () => {
  let commit!: (rows: Array<{ id: string }>) => void;
  let writes = 0;
  const notifications: EnterpriseSettlementNotice[] = [];
  const ledger = createPostgresRevenueLedger(database(async () => {
    writes++;
    if (writes === 1) return new Promise(resolve => { commit = resolve; });
    return writes === 2 ? [] : [{ id: entry.id }];
  }), "synthetic-encryption-key", notification => notifications.push(notification));
  const pending = ledger.record(entry);
  assert.equal(notifications.length, 0, "uncommitted settlement cannot emit");
  commit([{ id: entry.id }]);
  assert.equal(await pending, true);
  assert.deepEqual(notifications, [notice]);
  assert.equal(await ledger.record(entry), false);
  assert.equal(notifications.length, 1, "duplicate database row cannot emit");
  await ledger.record({ ...entry, channel: "NIP-90" });
  assert.equal(notifications.length, 1);
});

test("failed database writes do not emit; a successful database retry emits once", async () => {
  let writes = 0;
  let delivered = 0;
  const ledger = createPostgresRevenueLedger(database(async () => {
    if (++writes <= 2) throw new Error("database unavailable");
    return [{ id: entry.id }];
  }), "synthetic-encryption-key", () => { delivered++; });
  await assert.rejects(ledger.record(entry), /database unavailable/);
  assert.equal(delivered, 0);
  assert.equal(await recordRevenueWithRetry(ledger, entry, { attempts: 2, delayMs: 0 }), true);
  assert.equal(delivered, 1);
});

test("settlement completes before a hung webhook; notifier errors cannot retry the database", async () => {
  let finish!: (response: Response) => void;
  const dispatcher = createEnterpriseWebhookDispatcher({
    getUrl: () => endpoint,
    fetch: async () => new Promise<Response>(resolve => { finish = resolve; }),
  });
  let writes = 0;
  const db = database(async () => { writes++; return [{ id: entry.id }]; });
  const ledger = createPostgresRevenueLedger(db, "synthetic-encryption-key", dispatcher.dispatch);
  assert.equal(await ledger.record(entry), true);
  assert.equal(writes, 1);
  assert.equal(dispatcher.inFlight, 1);
  await nextTurn();
  assert.equal(dispatcher.inFlight, 1, "database success did not wait for the webhook");
  finish(new Response());
  await nextTurn();
  const broken = createPostgresRevenueLedger(db, "synthetic-encryption-key", () => {
    throw new Error("webhook configuration unavailable");
  });
  assert.equal(await recordRevenueWithRetry(broken, entry), true);
  assert.equal(writes, 2, "a notification failure must not retry settlement");
});
