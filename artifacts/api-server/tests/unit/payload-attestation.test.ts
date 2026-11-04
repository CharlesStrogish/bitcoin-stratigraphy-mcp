import assert from "node:assert/strict";
import test from "node:test";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  loadPayloadSigningKey,
  payloadAttestation,
  payloadPublicIdentity,
} from "../../src/lib/payload-attestation";

test("dedicated identity is stable, separate, fail-closed and accepts Ed25519 PEM", () => {
  const env = { SESSION_SECRET: "synthetic-test-only" };
  const a = loadPayloadSigningKey(env);
  assert.deepEqual(
    payloadPublicIdentity(a),
    payloadPublicIdentity(loadPayloadSigningKey(env)),
  );
  const pem = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  assert.equal(
    payloadPublicIdentity(
      loadPayloadSigningKey({ STRATIGRAPHY_PAYLOAD_PRIVATE_KEY: pem }),
    ).algorithm,
    "Ed25519",
  );
  assert.throws(() =>
    loadPayloadSigningKey({ STRATIGRAPHY_PAYLOAD_PRIVATE_KEY: "invalid" }),
  );
  assert.throws(() => loadPayloadSigningKey({ SESSION_SECRET: "" }));
  assert.throws(() => loadPayloadSigningKey({ NODE_ENV: "production" }));
  assert.throws(() =>
    loadPayloadSigningKey({
      STRATIGRAPHY_PAYLOAD_PRIVATE_KEY: generateKeyPairSync("rsa", {
        modulusLength: 2048,
      })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    }),
  );
});

for (const mode of ["json", "transport", "sse", "oversize", "unavailable"]) {
  test(`wire payload signature covers final bytes: ${mode}`, async (t) => {
    const key = generateKeyPairSync("ed25519").privateKey;
    const app = express();
    app.use(
      express.json({
        verify(req, _res, bytes) {
          (req as typeof req & { rawBody: Buffer }).rawBody =
            Buffer.from(bytes);
        },
      }),
    );
    app.use(
      payloadAttestation(() => {
        if (mode === "unavailable") throw new Error("synthetic failure");
        return key;
      }),
    );
    app.post("/mcp", (_req, res) => {
      if (mode === "json") res.json({ result: { amount: 21, unicode: "₿" } });
      else {
        res.writeHead(200, {
          "Content-Type":
            mode === "sse" ? "text/event-stream" : "application/json",
        });
        res.flushHeaders();
        if (mode === "oversize") res.end("x".repeat(8 * 1024 * 1024 + 1));
        else if (mode === "sse") {
          res.write(": heartbeat\n\n");
          res.end('data: {"result":21}\n\n');
        } else {
          res.write('{"result":');
          res.end("21}");
        }
      }
    });
    const server = app.listen(0, "127.0.0.1");
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    );
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const request = '{ "jsonrpc": "2.0", "id":1,"method":"tools/call" }';
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: request,
      },
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (mode === "unavailable") {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("X-Stratigraphy-Signature"), null);
      return;
    }
    assert.equal(response.status, mode === "oversize" ? 503 : 200);
    const signature = response.headers.get("X-Stratigraphy-Signature")!;
    assert.match(signature, /^v1,[A-Za-z0-9+/]{86}==$/);
    const prefix = Buffer.from(
      `bitcoinstratigraphy/payload/v1\n${createHash("sha256").update(request).digest("hex")}\n`,
    );
    assert.equal(
      verify(
        null,
        Buffer.concat([prefix, bytes]),
        createPublicKey(key),
        Buffer.from(signature.slice(3), "base64"),
      ),
      true,
    );
    assert.equal(
      verify(
        null,
        Buffer.concat([prefix, bytes, Buffer.from(" ")]),
        createPublicKey(key),
        Buffer.from(signature.slice(3), "base64"),
      ),
      false,
    );
    assert.match(
      response.headers.get("Access-Control-Expose-Headers")!,
      /X-Stratigraphy-Signature/,
    );
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
}
