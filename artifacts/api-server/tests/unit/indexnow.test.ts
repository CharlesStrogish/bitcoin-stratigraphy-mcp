import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import express from "express";
import { INDEXNOW_KEY, registerIndexNowRoute } from "../../src/routes/indexnow";

test("IndexNow serves only its exact public key path and preserves downstream security", async () => {
  assert.match(INDEXNOW_KEY, /^[a-f0-9]{32}$/);
  const app = express();
  registerIndexNowRoute(app);
  app.use((_req, res) => { res.status(401).send("protected"); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolveListening) => server.once("listening", resolveListening));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const path = `/${INDEXNOW_KEY}.txt`;
    const response = await fetch(base + path, {
      headers: { Authorization: "L402 invalid:invalid" },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), INDEXNOW_KEY);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain; charset=utf-8$/);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const head = await fetch(base + path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const denied = await fetch(base + path, { method });
      assert.equal(denied.status, 405);
      assert.equal(denied.headers.get("allow"), "GET, HEAD");
    }
    for (const other of ["/private", "/api/v1/enterprise/fleet", "/other.txt", `${path}/private`]) {
      const denied = await fetch(base + other);
      assert.equal(denied.status, 401);
      assert.equal(await denied.text(), "protected");
    }
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => error ? reject(error) : resolveClose()),
    );
  }
});

test("standalone IndexNow utility builds the exact six-URL matrix without sending on import", async () => {
  // Native dynamic import keeps this CLI out of the test bundle and never runs its main guard.
  const scriptUrl = pathToFileURL(resolve("../../scripts/indexnow-ping.js")).href;
  const script = await import(scriptUrl);
  assert.equal(script.INDEXNOW_KEY, INDEXNOW_KEY);
  assert.deepEqual(script.buildIndexNowPayload(), {
    host: "bitcoinstratigraphy.com",
    key: INDEXNOW_KEY,
    keyLocation: `https://bitcoinstratigraphy.com/${INDEXNOW_KEY}.txt`,
    urlList: [
      "https://bitcoinstratigraphy.com/",
      "https://bitcoinstratigraphy.com/openapi.json",
      "https://bitcoinstratigraphy.com/.well-known/ai-plugin.json",
      "https://bitcoinstratigraphy.com/.well-known/mcp-configuration.json",
      "https://bitcoinstratigraphy.com/yield-proofs.json",
      "https://bitcoinstratigraphy.com/sitemap.xml",
    ],
  });
});
