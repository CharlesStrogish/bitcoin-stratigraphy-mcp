import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import {
  createNip98RevocationGuard, registerNip98RevocationAdmin,
} from "../../src/middleware/nip98-revocation";
import {
  createPostgresNip98RevocationStore, type Nip98RevocationStore,
} from "../../src/lib/nip98-revocation-store";
import { registerAuditRoutes } from "../../src/routes/audit";
import { registerComplianceRoutes } from "../../src/routes/compliance";
import { canonical, issuerKeyId } from "../../src/lib/article12-signature";

test("revocation rejects fresh valid NIP-98 before execution and is idempotent and operator-only", async () => {
  const revoked = new Map<string, string>();
  const store: Nip98RevocationStore = {
    async snapshot() { return { as_of: new Date().toISOString(), revoked_keys: [...revoked].map(([pubkey, revoked_at]) => ({ pubkey, revoked_at })) }; },
    async isRevoked(key) { return revoked.has(key); },
    async revoke(key) {
      if (!revoked.has(key)) revoked.set(key, new Date().toISOString());
      return { pubkey: key, revoked_at: revoked.get(key)! };
    },
  };
  let executed = 0;
  const app = express();
  app.use(express.json({ verify(req, _res, bytes) {
    (req as express.Request & { rawBody: Buffer }).rawBody = Buffer.from(bytes);
  } }));
  app.use(createNip98RevocationGuard(store));
  registerNip98RevocationAdmin(app, store, "test-operator");
  app.post("/paid", (_req, res) => { executed++; res.json({ ok: true }); });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const body = '{ "sample": 1 }';
  const auth = () => "Nostr " + Buffer.from(JSON.stringify(finalizeEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
    tags: [["u", `${origin}/paid`], ["method", "POST"],
      ["payload", createHash("sha256").update(body).digest("hex")]],
  }, secret))).toString("base64");
  const request = () => fetch(`${origin}/paid`, {
    method: "POST", body,
    headers: { "Content-Type": "application/json", "X-Nostr-Authorization": auth(),
      Authorization: "L402 already-paid:cached-proof" },
  });
  const revoke = (key: unknown, authorization = "Bearer test-operator") =>
    fetch(`${origin}/api/admin/revoke_key`, { method: "POST",
      headers: { "Content-Type": "application/json", authorization },
      body: JSON.stringify({ pubkey: key }) });
  try {
    assert.equal((await request()).status, 200);
    assert.equal(executed, 1);
    assert.equal((await revoke(pubkey, "Bearer wrong")).status, 403);
    assert.equal(revoked.size, 0);
    assert.equal((await revoke("not-a-key")).status, 400);
    const first = await (await revoke(pubkey.toUpperCase())).json();
    const again = await (await revoke(pubkey)).json();
    assert.deepEqual(first, again);
    assert.equal((await request()).status, 403);
    assert.equal(executed, 1, "no invoice, cache hit or handler executes for revoked identity");
    // Another signer remains allowed and the raw signed body cannot be altered.
    const secondSecret = generateSecretKey();
    const event = finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "",
      tags: [["u", `${origin}/paid`], ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")]],
    }, secondSecret);
    const header = "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64");
    assert.equal((await fetch(`${origin}/paid`, { method: "POST", body,
      headers: { "Content-Type": "application/json", Authorization: header } })).status, 200);
    assert.equal((await fetch(`${origin}/paid`, { method: "POST", body: '{"sample":2}',
      headers: { "Content-Type": "application/json", Authorization: header } })).status, 401);
    store.isRevoked = async () => { throw new Error("DB down"); };
    assert.equal((await request()).status, 503);
    assert.equal(executed, 2);
    // Requests with no authenticated identity remain backward compatible.
    assert.equal((await fetch(`${origin}/paid`, { method: "POST" })).status, 200);
  } finally {
    server.closeAllConnections(); server.close(); await once(server, "close");
  }
});

test("raw audit route also rejects revoked keys before invoking its worker", async () => {
  const secret = generateSecretKey();
  const store: Nip98RevocationStore = {
    async snapshot() { throw new Error("not used"); },
    async isRevoked() { return true; },
    async revoke(pubkey) { return { pubkey, revoked_at: new Date().toISOString() }; },
  };
  const app = express();
  registerAuditRoutes(app, async () => { throw new Error("must not execute"); },
    createNip98RevocationGuard(store));
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/audit/verify`;
  const body = '{"audit":"raw bytes"}\n';
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000),
    content: "", tags: [["u", url], ["method", "POST"],
      ["payload", createHash("sha256").update(body).digest("hex")]] }, secret);
  try {
    const response = await fetch(url, { method: "POST", body,
      headers: { "Content-Type": "text/plain",
        Authorization: "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64") } });
    assert.equal(response.status, 403);
  } finally {
    server.closeAllConnections(); server.close(); await once(server, "close");
  }
});

test("persistent CRL normalizes keys, reads every time, and propagates DB errors", async () => {
  const rows = new Set<string>();
  let checks = 0;
  const database = {
    async query(text: string, values?: unknown[]) {
      const key = values?.[0] as string;
      if (text.includes("CREATE TABLE")) return { rows: [] };
      if (text.includes("INSERT INTO")) {
        rows.add(key);
        return { rows: [{ pubkey: key, revoked_at: new Date("2026-01-01T00:00:00Z") }] };
      }
      checks++;
      return { rows: [{ revoked: rows.has(key) }] };
    },
  };
  // This fake models persistent storage shared by separately-created store instances.
  const store = createPostgresNip98RevocationStore(database as never);
  const key = "AB".repeat(32);
  assert.equal(await store.isRevoked(key), false);
  await store.revoke(key);
  assert.equal(await createPostgresNip98RevocationStore(database as never).isRevoked(key), true);
  assert.equal(checks, 2);
  await assert.rejects(store.revoke("invalid"));
  const failing = createPostgresNip98RevocationStore({
    query: async () => { throw new Error("DB unavailable"); },
  } as never);
  await assert.rejects(failing.isRevoked(key), /DB unavailable/);
});

test("public CRL export signs the full registry, changes after revocation and fails closed", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const registry = { as_of: new Date().toISOString(), revoked_keys: [] as { pubkey: string; revoked_at: string }[] };
  const store: Nip98RevocationStore = {
    async snapshot() { return registry; },
    async isRevoked() { return false; },
    async revoke(pubkey) { const entry = { pubkey, revoked_at: registry.as_of }; registry.revoked_keys.push(entry); return entry; },
  };
  const app = express();
  registerComplianceRoutes(app, store, () => privateKey);
  const server = app.listen(0); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/v1/compliance/revocation-snapshot`;
  try {
    for (const size of [0, 1]) {
      if (size) await store.revoke("ab".repeat(32));
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const { issuer_attestation, ...payload } = await response.json();
      assert.equal(payload.revoked_keys.length, size);
      assert.equal(payload.issuer_key_id, issuerKeyId(privateKey));
      assert.equal(Date.parse(payload.next_update) - Date.parse(payload.as_of), 900000);
      assert.ok(verify(null, Buffer.from("bitcoin-stratigraphy/nip98-crl/v1\n" + canonical(payload)),
        publicKey, Buffer.from(issuer_attestation.signature, "base64")));
    }
    store.snapshot = async () => { throw new Error("database unavailable"); };
    const failed = await fetch(url);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).revoked_keys, undefined);
  } finally {
    server.closeAllConnections(); server.close(); await once(server, "close");
  }
});

test("Postgres CRL capture uses one ordered MVCC query without cached registry entries", async () => {
  let captures = 0;
  const store = createPostgresNip98RevocationStore({ async query(sql: string) {
    if (sql.includes("CREATE TABLE")) return { rows: [] };
    captures++;
    assert.match(sql, /statement_timestamp\(\)/);
    assert.match(sql, /ORDER BY pubkey/);
    return { rows: [{ as_of: new Date("2026-10-23T00:00:00Z"),
      revoked_keys: [{ pubkey: "ab".repeat(32), revoked_at: "2026-10-22T00:00:00Z" }] }] };
  } } as never);
  for (let i = 0; i < 2; i++) assert.deepEqual(await store.snapshot(), {
    as_of: "2026-10-23T00:00:00.000Z",
    revoked_keys: [{ pubkey: "ab".repeat(32), revoked_at: "2026-10-22T00:00:00.000Z" }],
  });
  assert.equal(captures, 2);
});
