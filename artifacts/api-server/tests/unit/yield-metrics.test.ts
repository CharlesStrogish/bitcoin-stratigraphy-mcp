import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { pool } from "@workspace/db";
import { createYieldMetricsReader, YIELD_METRICS_SQL } from "../../src/lib/yield-metrics";
import { registerYieldMetricsRoutes } from "../../src/routes/yield-metrics";
import { apiRootAliases } from "../../src/middleware/apiRootAliases";

const genesis = {
  total_claims_processed: 0,
  total_yield_distributed_sats: 0,
  payout_reliability_score: "100.00%",
  status: "Healthy",
};

test("public yield metrics return HTTP 200 and perfect Genesis reliability from an empty PostgreSQL ledger", async () => {
  const schema = "yield_metrics_test_" + randomBytes(8).toString("hex");
  assert.match(schema, /^[a-z0-9_]+$/);
  const client = await pool.connect();
  let server: ReturnType<express.Express["listen"]> | undefined;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE private_yield_claims (
      id text PRIMARY KEY, total_msats bigint NOT NULL CHECK(total_msats > 0),
      settlement_mode text NOT NULL DEFAULT 'mainnet',
      payment_status text NOT NULL DEFAULT 'settled')`);
    let reads = 0;
    let clock = 0;
    const read = createYieldMetricsReader({
      query: async () => { reads++; return client.query(YIELD_METRICS_SQL); },
      now: () => clock,
    });
    const app = express();
    app.use(apiRootAliases);
    registerYieldMetricsRoutes(app, read);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const path of ["/yield-metrics.json", "/api/yield-metrics", "/api/yield-metrics.json", "/api/api/yield-metrics"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-yield-scope"), "mainnet-outbound");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.match(response.headers.get("access-control-expose-headers")!, /X-Yield-Scope/);
      assert.deepEqual(await response.json(), genesis);
    }
    assert.equal(reads, 1);
    assert.equal((await fetch(origin + "/yield-metrics.json", { method: "HEAD" })).status, 200);
    assert.equal((await fetch(origin + "/api/yield-metrics", { method: "OPTIONS" })).status, 204);
    assert.equal((await fetch(origin + "/yield-metrics.json", { method: "POST" })).status, 405);
    assert.equal(reads, 1);
    await client.query("INSERT INTO private_yield_claims (id,total_msats) VALUES ('private-claim-a',21000),('private-claim-b',1050)");
    assert.deepEqual(await read(), genesis); // Cached until the bounded refresh.
    clock = 30_001;
    const response = await fetch(origin + "/yield-metrics.json");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      total_claims_processed: 2, total_yield_distributed_sats: 22.05,
      payout_reliability_score: "100.00%", status: "Healthy",
    });
    assert.equal(reads, 2);
    assert.equal((await client.query("SELECT COUNT(*)::integer AS count FROM private_yield_claims")).rows[0].count, 2);
    await client.query(`INSERT INTO private_yield_claims VALUES
      ('historical-mock',999000,'mock','settled'),('pending-live',888000,'mainnet','pending'),
      ('failed-live',1000,'mainnet','failed')`);
    clock = 60_002;
    assert.deepEqual(await read(), { total_claims_processed: 3, total_yield_distributed_sats: 22.05,
      payout_reliability_score: "66.67%", status: "Healthy" });
  } finally {
    if (server) { server.close(); await once(server, "close"); }
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});

test("parallel readers share one query and cannot mutate the cached snapshot", async () => {
  let calls = 0;
  const read = createYieldMetricsReader({ query: async () => {
    calls++;
    await new Promise<void>(resolve => setImmediate(resolve));
    return { rows: [{ total_claims: "0", total_msats: "0", successful_claims: "0" }] };
  } });
  const results = await Promise.all(Array.from({ length: 20 }, () => read()));
  assert.equal(calls, 1);
  assert.deepEqual(results[0], genesis);
  results[0]!.total_claims_processed = 999;
  assert.deepEqual(await read(), genesis);
});

test("storage failures are 503, never a fabricated Healthy Genesis; retries are bounded", async () => {
  let clock = 0;
  let calls = 0;
  const read = createYieldMetricsReader({ now: () => clock, query: async () => {
    calls++;
    throw new Error("private database failure");
  } });
  const app = express();
  registerYieldMetricsRoutes(app, read);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/yield-metrics.json`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-yield-scope"), "mainnet-outbound");
      assert.deepEqual(await response.json(), { error: "YIELD_METRICS_UNAVAILABLE" });
    }
    assert.equal(calls, 1);
    clock = 5001;
    await assert.rejects(read());
    assert.equal(calls, 2);
  } finally { server.close(); await once(server, "close"); }
});
