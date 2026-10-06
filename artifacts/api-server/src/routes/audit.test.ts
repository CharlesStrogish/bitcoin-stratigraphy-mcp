// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerAuditRoutes } from "./audit";
import { AuditWorkerError, type AuditRequest, verifyAuditEvidence } from "../services/auditVerification";

const report = {
  generatedUtc: "2026-10-06T00:00:00Z", method: "public header corroboration",
  scope: "journal" as const, journalIntegrity: "consistent" as const, exitCode: 0 as const,
  issues: [], limitations: "Not legal certification",
  traces: [{ traceId: "test", timestampUtc: "2026-10-06T00:00:00Z", agentId: "test",
    sha256: "a".repeat(64), status: "pending" as const, label: "Pending Calendar", detail: "" }],
};
async function server(t: TestContext, verify: typeof verifyAuditEvidence = async () => report) {
  const app = express();
  registerAuditRoutes(app, verify);
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => http.once("listening", resolve));
  t.after(() => { http.closeAllConnections(); http.close(); });
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/audit/verify`;
}

test("public JSON verification is free, private, and uses the trace contract", async t => {
  let received: AuditRequest | undefined;
  const url = await server(t, async input => { received = input; return report; });
  const body = '{"trace":{"agent_id":"test"},"otsProofHex":"aa"}';
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(received, { mode: "trace", content: body });
  assert.equal((await response.json() as typeof report).traces[0].status, "pending");
});

test("uploaded NDJSON bytes are passed unchanged and no filename is used", async t => {
  let received: AuditRequest | undefined;
  const url = await server(t, async input => { received = input; return report; });
  const body = '{"kind":"trace"}\n{"kind":"status"}\n';
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body });
  assert.equal(response.status, 200);
  assert.deepEqual(received, { mode: "journal", content: body });
});

test("rejects empty, malformed UTF8, unsupported and oversized uploads", async t => {
  let calls = 0;
  const url = await server(t, async () => { calls++; return report; });
  for (const [body, type, status] of [
    ["", "text/plain", 400], [Buffer.from([0xff]), "text/plain", 400],
    ["x", "multipart/form-data", 415], ["x".repeat(1024 * 1024 + 1), "text/plain", 413],
  ] as const) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": type }, body });
    assert.equal(response.status, status);
  }
  assert.equal(calls, 0);
});

test("rate limit does not issue payment challenges", async t => {
  const url = await server(t);
  for (let i = 0; i < 10; i++) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    assert.equal(response.status, 200);
  }
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("worker failure is explicit and does not echo internal errors", async t => {
  const url = await server(t, async () => { throw new Error("sensitive internal configuration"); });
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Verification unavailable" });
});

test("malformed worker submission gets a structured 400, not payment or verified", async t => {
  const url = await server(t, async () => { throw new AuditWorkerError(400, "Malformed submission"); });
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Malformed submission" });
});
