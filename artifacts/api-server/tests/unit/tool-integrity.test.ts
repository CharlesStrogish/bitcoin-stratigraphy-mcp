// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import {
  createToolIntegrityManifest,
  loadToolIntegrityKey,
} from "../../src/lib/tool-integrity";
import { registerToolIntegrityRoute } from "../../src/routes/tool-integrity";
import { ASYNC_WEBHOOK_DESCRIPTION_SUFFIX } from "../../src/lib/stratigraphy-tool-descriptions";
import {
  mcpToolDefinitions,
  registerMcpRequestGuard,
  registerMcpRoute,
} from "../../src/routes/mcp";
import { registerMcpServerCardRoute } from "../../src/routes/mcp-server-card";
import { registerPublicCors } from "../../src/middleware/publicCors";
import { apiRootAliases } from "../../src/middleware/apiRootAliases";

const publicPem = (key: ReturnType<typeof loadToolIntegrityKey>) =>
  createPublicKey(key).export({ type: "spki", format: "pem" });
const fixtureTools = Array.from({ length: 16 }, (_, i) => ({
  name: `fixture.${i}`,
  description: `Exact description ${i}: é, e\u0301, ₿.\n Keep  whitespace. `,
}));

test("local signing keys persist without exposing private files or replacing malformed keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "tool-integrity-"));
  const keysDir = join(directory, ".keys");
  try {
    const first = loadToolIntegrityKey({}, keysDir);
    const second = loadToolIntegrityKey({}, keysDir);
    assert.equal(publicPem(first), publicPem(second));
    assert.equal(statSync(keysDir).mode & 0o777, 0o700);
    const path = join(keysDir, "tool-integrity-ed25519.pem");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(keysDir), ["tool-integrity-ed25519.pem"]);
    writeFileSync(path, "corrupt key");
    assert.throws(() => loadToolIntegrityKey({}, keysDir));
    assert.equal(readFileSync(path, "utf8"), "corrupt key");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persistent environment seeds survive ephemeral filesystems and dedicated keys take priority", () => {
  const directory = mkdtempSync(join(tmpdir(), "tool-integrity-env-"));
  try {
    const env = { SESSION_SECRET: "test-only-persistent-session-secret" };
    const first = loadToolIntegrityKey(env, join(directory, "first"));
    const second = loadToolIntegrityKey(env, join(directory, "second"));
    assert.equal(publicPem(first), publicPem(second));
    assert.notEqual(
      publicPem(first),
      publicPem(
        loadToolIntegrityKey({ SESSION_SECRET: "different-test-secret" }),
      ),
    );
    const dedicated = generateKeyPairSync("ed25519").privateKey;
    assert.equal(
      publicPem(
        loadToolIntegrityKey({
          ...env,
          TOOL_INTEGRITY_PRIVATE_KEY: dedicated
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        }),
      ),
      publicPem(dedicated),
    );
    assert.deepEqual(readdirSync(directory), []);
    assert.throws(() => loadToolIntegrityKey({ SESSION_SECRET: "" }));
    assert.throws(() =>
      loadToolIntegrityKey({ ...env, TOOL_INTEGRITY_PRIVATE_KEY: "invalid" }),
    );
    const wrongType = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }).privateKey;
    assert.throws(
      () =>
        loadToolIntegrityKey({
          TOOL_INTEGRITY_PRIVATE_KEY: wrongType
            .export({ type: "pkcs8", format: "pem" })
            .toString(),
        }),
      /Ed25519/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all 16 exact description digests verify, and tampering, normalization and wrong keys fail", () => {
  const key = generateKeyPairSync("ed25519").privateKey;
  const manifest = createToolIntegrityManifest(
    fixtureTools,
    key,
    new Date("2026-10-18T00:00:00Z"),
  );
  assert.equal(manifest.algorithm, "Ed25519");
  assert.equal(manifest.timestamp, "2026-10-18T00:00:00.000Z");
  assert.equal(manifest.tools.length, 16);
  assert.equal(manifest.server_public_key, publicPem(key));
  assert.equal(
    manifest.key_id,
    createHash("sha256")
      .update(createPublicKey(key).export({ type: "spki", format: "der" }))
      .digest("hex"),
  );
  const wrongKey = generateKeyPairSync("ed25519").publicKey;
  for (const [i, tool] of manifest.tools.entries()) {
    const digest = createHash("sha256")
      .update(fixtureTools[i]!.description, "utf8")
      .digest();
    const signature = Buffer.from(tool.signature, "base64");
    assert.equal(tool.description_hash, digest.toString("hex"));
    assert.equal(signature.length, 64);
    assert.equal(
      verify(null, digest, manifest.server_public_key, signature),
      true,
    );
    assert.equal(verify(null, digest, wrongKey, signature), false);
    assert.equal(
      verify(
        null,
        createHash("sha256")
          .update(fixtureTools[i]!.description.trim().normalize("NFC"))
          .digest(),
        manifest.server_public_key,
        signature,
      ),
      false,
    );
    signature[0] = signature[0]! ^ 1;
    assert.equal(
      verify(null, digest, manifest.server_public_key, signature),
      false,
    );
  }
  assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE KEY/);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.tools));
  assert.ok(manifest.tools.every(Object.isFrozen));
  assert.throws(
    () => createToolIntegrityManifest(fixtureTools.slice(1), key),
    /16/,
  );
  assert.throws(
    () =>
      createToolIntegrityManifest(
        [...fixtureTools.slice(1), fixtureTools[1]!],
        key,
      ),
    /uniquely/,
  );
});

test("public integrity route matches live tools/list after final overlays, without changing discovery or L402", async () => {
  const app = express();
  app.use(apiRootAliases);
  registerPublicCors(app);
  registerMcpRequestGuard(app);
  app.use(express.json());
  registerMcpServerCardRoute(app);
  registerMcpRoute(app, {
    sessionSecret: "integrity-route-test-secret",
    x402ResourceServer: null,
    settlementRouter: {
      isConfigured: () => true,
      activeProvider: () => "integrity-test",
      circuitState: () => "closed",
      createInvoice: async () => ({
        invoice: "lnbc2500n1integritytest",
        paymentHash: "cd".repeat(32),
        provider: "integrity-test",
      }),
      verifyPayment: async () => "invalid",
    },
  });
  const manifest = registerToolIntegrityRoute(
    app,
    mcpToolDefinitions,
    generateKeyPairSync("ed25519").privateKey,
  );
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of [
      "/.well-known/integrity.json",
      "/api/.well-known/integrity.json",
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(res.headers.get("www-authenticate"), null);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await res.json(), manifest);
      const head = await fetch(base + path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    const list = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    assert.equal(body.result.tools.length, 16);
    assert.deepEqual(
      manifest.tools.map((t) => t.name),
      body.result.tools.map((t) => t.name),
    );
    // The zero-polling suffix is part of the signed text, not appended later.
    const asyncTools = body.result.tools.filter((tool) =>
      tool.description.endsWith(ASYNC_WEBHOOK_DESCRIPTION_SUFFIX),
    );
    assert.deepEqual(asyncTools.map((tool) => tool.name).sort(), [
      "proof.submit",
      "stratigraphy.get_range",
    ]);
    for (const tool of body.result.tools) {
      const entry = manifest.tools.find((item) => item.name === tool.name)!;
      const digest = createHash("sha256")
        .update(tool.description, "utf8")
        .digest();
      assert.equal(entry.description_hash, digest.toString("hex"), tool.name);
      assert.equal(
        verify(
          null,
          digest,
          manifest.server_public_key,
          Buffer.from(entry.signature, "base64"),
        ),
        true,
        tool.name,
      );
    }
    for (const path of [
      "/.well-known/mcp.json",
      "/.well-known/glama.json",
      "/.well-known/mcp/server-card.json",
    ]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      await res.json();
    }
    const paid = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "proof.notarize",
          arguments: { hash: "ab".repeat(32) },
        },
      }),
    });
    assert.equal(paid.status, 402, await paid.text());
    assert.match(paid.headers.get("www-authenticate") ?? "", /L402/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
