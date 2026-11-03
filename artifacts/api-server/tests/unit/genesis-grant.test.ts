// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { pool } from "@workspace/db";
import {
  createPostgresGenesisGrantStore,
  type GenesisGrantStore,
} from "../../src/lib/genesis-grant-store";
import { registerMcpRoute, indexedContractTestFixture } from "../../src/routes/mcp";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import type { SettlementRouter } from "../../src/services/settlement";
import { withInvoicePow } from "../../../../sdk/typescript/invoice-pow";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const admittedFetch = withInvoicePow(fetch, sha);
let client: Awaited<ReturnType<typeof pool.connect>>;
const schema = `genesis_test_${randomUUID().replace(/-/g, "")}`;
const database = {
  // A real pool uses independent connections for overlapping worker requests.
  query: ((text: string, values?: unknown[]) =>
    pool.query(text.replaceAll("genesis_grants", `${schema}.genesis_grants`), values)) as typeof pool.query,
};
let store: GenesisGrantStore;
let invoices = 0;
let requestId = 0;
const servers: ReturnType<express.Express["listen"]>[] = [];
const router: SettlementRouter = {
  isConfigured: () => true,
  activeProvider: () => "genesis-test",
  circuitState: () => "closed",
  async createInvoice() {
    invoices++;
    return { invoice: "lnbc1genesistest", paymentHash: "ab".repeat(32), provider: "genesis-test" };
  },
  async verifyPayment() { return "invalid"; },
};

before(async () => {
  client = await pool.connect();
  // A private schema isolates real multi-connection races from user grant rows.
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE genesis_grants (
    pubkey text PRIMARY KEY CHECK (pubkey ~ '^[0-9a-f]{64}$'),
    successful_calls integer NOT NULL DEFAULT 0,
    reservations text[] NOT NULL DEFAULT '{}',
    CHECK (successful_calls >= 0 AND successful_calls + cardinality(reservations) <= 10)
  )`);
  store = createPostgresGenesisGrantStore(database);
});
after(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  if (client) {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.query("RESET search_path");
    client.release();
  }
  await pool.end();
});

async function worker(grants: GenesisGrantStore = store, failSigning: boolean | "tool-error" = false) {
  const app = express();
  app.use(express.json({ verify(req, _res, bytes) {
    (req as express.Request & { rawBody: Buffer }).rawBody = Buffer.from(bytes);
  } }));
  app.locals.signMcpToolResponse = (_name: string, result: unknown) => {
    if (failSigning === true) throw new Error("synthetic tool response failure");
    if (failSigning === "tool-error") return { ...(result as object), isError: true };
    return result;
  };
  registerMcpRoute(app, {
    genesisGrantStore: grants,
    sessionSecret: "genesis-test-secret",
    settlementRouter: router,
    x402ResourceServer: null,
    revocationStore: createMemoryMacaroonRevocationStore(),
    stratigraphyBackend: indexedContractTestFixture,
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function call(url: string, key?: Uint8Array, options: {
  name?: string; stale?: boolean; wrongPayload?: boolean; forged?: boolean;
  path?: string; credential?: boolean;
} = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call",
    params: { name: options.name ?? "mesh.get_status", arguments: {},
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {} } } });
  const headers = new Headers({
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call",
    "Mcp-Name": options.name ?? "mesh.get_status",
  });
  if (key) {
    const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000) - (options.stale ? 120 : 0),
      tags: [["u", options.path ?? url], ["method", "POST"],
        ["payload", sha(options.wrongPayload ? "{}" : body)]], content: "" }, key);
    if (options.forged) event.sig = "00".repeat(64);
    headers.set("Authorization", `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`);
  }
  if (options.credential) {
    headers.set("X-Nostr-Authorization", headers.get("Authorization")!);
    headers.set("Authorization", `L402 invalid:${"00".repeat(32)}`);
  }
  const response = await admittedFetch(url, { method: "POST", headers, body });
  return { status: response.status, grant: response.headers.get("X-Genesis-Grant"),
    body: await response.json() as Record<string, any> };
}

test("ten authenticated MCP executions bypass invoices; call 11 resumes 402 across worker replacement", async () => {
  const key = generateSecretKey();
  const startInvoices = invoices;
  let url = await worker();
  for (let index = 0; index < 10; index++) {
    if (index === 5) url = await worker(createPostgresGenesisGrantStore(database));
    const response = await call(url, key, index % 2 ? { name: "payment.get_info" } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.result && !response.body.error && !response.body.result.isError);
    assert.equal(response.grant, `${9 - index} calls remaining before L402 activation`);
  }
  assert.equal(invoices, startInvoices);
  const eleventh = await call(url, key);
  assert.equal(eleventh.status, 402);
  assert.equal(eleventh.grant, null);
  assert.equal(invoices, startInvoices + 1);
  const { rows } = await client.query("SELECT * FROM genesis_grants WHERE pubkey=$1", [getPublicKey(key)]);
  assert.equal(rows[0].successful_calls, 10);
  assert.deepEqual(rows[0].reservations, []);
  // Another authenticated identity still has its own ten-call quota.
  assert.equal((await call(url, generateSecretKey())).grant, "9 calls remaining before L402 activation");
});

test("parallel calls and shared-store workers cannot exceed ten grants", async () => {
  const key = generateSecretKey();
  const urls = [await worker(), await worker(createPostgresGenesisGrantStore(database))];
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => call(urls[index % 2]!, key)));
  assert.equal(responses.filter(result => result.status === 200).length, 10);
  assert.equal(responses.filter(result => result.status === 402).length, 10);
  assert.equal(new Set(responses.filter(result => result.grant).map(result => result.grant)).size, 10);
  const { rows } = await client.query("SELECT successful_calls FROM genesis_grants WHERE pubkey=$1", [getPublicKey(key)]);
  assert.equal(rows[0].successful_calls, 10);
});

test("missing, stale, forged and incorrectly bound signatures never receive grants", async () => {
  const url = await worker();
  assert.equal((await call(url)).status, 402);
  const key = generateSecretKey();
  const startInvoices = invoices;
  for (const options of [{ stale: true }, { forged: true }, { wrongPayload: true }, { path: `${url}/wrong` }]) {
    const response = await call(url, key, options);
    assert.equal(response.status, 401);
    assert.equal(response.grant, null);
  }
  assert.equal(invoices, startInvoices);
  const { rowCount } = await client.query("SELECT * FROM genesis_grants WHERE pubkey=$1", [getPublicKey(key)]);
  assert.equal(rowCount, 0);
});

test("tool failures refund slots without earned receipts or lifetime successes", async () => {
  const key = generateSecretKey();
  const broken = await worker(store, true);
  const response = await call(broken, key);
  assert.ok(response.body.error);
  assert.equal(response.grant, null);
  const { rows } = await client.query("SELECT * FROM genesis_grants WHERE pubkey=$1", [getPublicKey(key)]);
  assert.equal(rows[0].successful_calls, 0);
  assert.deepEqual(rows[0].reservations, []);
  assert.equal((await call(await worker(), key)).grant, "9 calls remaining before L402 activation");
  const toolErrorKey = generateSecretKey();
  const toolError = await call(await worker(store, "tool-error"), toolErrorKey);
  assert.equal(toolError.body.result.isError, true);
  assert.equal(toolError.grant, null);
  assert.equal((await call(await worker(), toolErrorKey)).grant, "9 calls remaining before L402 activation");
});

test("grant accounting failure fails closed without executing or invoicing", async () => {
  const url = await worker({ async reserve() { throw new Error("synthetic db outage"); } });
  const startInvoices = invoices;
  const response = await call(url, generateSecretKey());
  assert.equal(response.status, 503);
  assert.equal(response.grant, null);
  assert.equal(invoices, startInvoices);
});

test("existing L402 credentials do not gain a grant fallback", async () => {
  const key = generateSecretKey();
  const response = await call(await worker(), key, { credential: true });
  assert.equal(response.status, 402);
  assert.equal(response.grant, null);
  const { rowCount } = await client.query("SELECT * FROM genesis_grants WHERE pubkey=$1", [getPublicKey(key)]);
  assert.equal(rowCount, 0);
});

test("reservation completion is idempotent and abandoned reservations cannot be reused", async () => {
  const pubkey = getPublicKey(generateSecretKey());
  const reservations = await Promise.all(Array.from({ length: 10 }, () => store.reserve(pubkey)));
  assert.ok(reservations.every(Boolean));
  assert.equal(await createPostgresGenesisGrantStore(database).reserve(pubkey), null);
  await reservations[0]!.complete(false);
  await reservations[0]!.complete(true);
  const replacement = await store.reserve(pubkey);
  assert.ok(replacement);
  await Promise.all([replacement.complete(true), replacement.complete(true), replacement.complete(false)]);
  const { rows } = await client.query("SELECT * FROM genesis_grants WHERE pubkey=$1", [pubkey]);
  assert.equal(rows[0].successful_calls, 1);
  assert.equal(rows[0].reservations.length, 9);
});
