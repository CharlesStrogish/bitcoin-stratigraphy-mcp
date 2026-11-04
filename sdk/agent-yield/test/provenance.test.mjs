import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FiduciaryClient,
  FiduciaryTamperingError,
} from "../dist/sdk/agent-yield/src/index.js";
import { json, signedFetch, serverPublicKey } from "./fixtures.mjs";

for (const mode of [
  "valid",
  "tampered",
  "missing",
  "malformed",
  "wrong-key",
  "no-pin",
  "wrong-request",
  "sse",
]) {
  test(`strict SDK payload provenance: ${mode}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "provenance-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fetcher = signedFetch(
      async (request) => {
        const body = await request.json();
        const result =
          body.method === "tools/list"
            ? { tools: [{ name: "free", inputSchema: { type: "object" } }] }
            : { structuredContent: { amount: 21, unicode: "₿" }, content: [] };
        const reply = { jsonrpc: "2.0", id: body.id, result };
        return mode === "sse" && body.method === "tools/call"
          ? new Response(`data: ${JSON.stringify(reply)}\n\n`, {
              headers: { "Content-Type": "text/event-stream" },
            })
          : json(reply);
      },
      async (response) => {
        const headers = new Headers(response.headers);
        const text = await response.text();
        if (mode === "missing") headers.delete("X-Stratigraphy-Signature");
        if (mode === "malformed")
          headers.set("X-Stratigraphy-Signature", "v1,invalid");
        return new Response(
          mode === "tampered"
            ? text.replace('"amount":21', '"amount":22')
            : mode === "wrong-request"
              ? text.replace('"id":2', '"id":3')
              : text,
          { headers },
        );
      },
    );
    const client = new FiduciaryClient({
      maxPaymentSats: 1,
      maxTotalSats: 1,
      stateDirectory: dir,
      fetch: fetcher,
      serverPublicKey:
        mode === "no-pin"
          ? undefined
          : mode === "wrong-key"
            ? generateKeyPairSync("ed25519")
                .publicKey.export({ type: "spki", format: "pem" })
                .toString()
            : serverPublicKey,
    });
    if (["valid", "sse"].includes(mode)) {
      const receipt = await client.callTool("free");
      assert.equal(receipt.provenance_verified, true);
      assert.deepEqual(receipt.payload, { amount: 21, unicode: "₿" });
    } else {
      await assert.rejects(
        client.callTool("free"),
        (error) =>
          error instanceof FiduciaryTamperingError &&
          error.message === "Data payload signature verification failed.",
      );
    }
  });
}
