import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  canonicalResultContent,
  signToolResponse,
  verifyToolResponse,
} from "../../src/lib/mcp-response-signature";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = 1_792_454_400;
const output = (): CallToolResult => ({
  content: [{ type: "text", text: "A Bitcoin claim: café ₿" }],
  structuredContent: { z: [null, true, { b: 2, a: 1 }], a: 1 },
  _meta: { existing: { retained: true } },
});

test("canonical content is deterministic, key-sorted, JSON-normalized and metadata-independent", () => {
  assert.equal(
    canonicalResultContent(output()),
    '{"content":[{"text":"A Bitcoin claim: café ₿","type":"text"}],"structuredContent":{"a":1,"z":[null,true,{"a":1,"b":2}]}}',
  );
  const reordered = output();
  reordered.structuredContent = {
    a: 1,
    z: [null, true, { a: 1, b: 2 }],
    omitted: undefined,
  };
  assert.equal(
    canonicalResultContent(reordered),
    canonicalResultContent(output()),
  );
  assert.equal(canonicalResultContent({ content: [] }), '{"content":[]}');
});

test("signs the exact tool.timestamp.sha256 string and preserves detached payload and metadata", () => {
  const original = output();
  const result = signToolResponse(
    "stratigraphy.list",
    original,
    privateKey,
    now,
  );
  assert.deepEqual(result.content, original.content);
  assert.deepEqual(result.structuredContent, original.structuredContent);
  assert.deepEqual(result._meta?.existing, original._meta?.existing);
  assert.equal(original._meta?.responseSignature, undefined);
  const digest = createHash("sha256")
    .update(canonicalResultContent(original), "utf8")
    .digest("hex");
  const expected = sign(
    null,
    Buffer.from(`stratigraphy.list.${now}.${digest}`),
    privateKey,
  ).toString("base64");
  assert.equal(
    (result._meta?.responseSignature as any).signature,
    `v1a,${expected}`,
  );
  assert.ok(verifyToolResponse("stratigraphy.list", result, publicKey, now));
  (original.structuredContent!.z as any[]).push("later backend mutation");
  assert.ok(verifyToolResponse("stratigraphy.list", result, publicKey, now));
});

test("rejects one-byte tampering in either payload representation, wrong tools, keys and timestamps", () => {
  const signed = signToolResponse(
    "stratigraphy.list",
    output(),
    privateKey,
    now,
  );
  const clone = () => structuredClone(signed);
  const textTamper = clone();
  (textTamper.content[0] as { text: string }).text += "!";
  const structuredTamper = clone();
  structuredTamper.structuredContent!.a = 2;
  assert.equal(
    verifyToolResponse("stratigraphy.list", textTamper, publicKey, now),
    false,
  );
  assert.equal(
    verifyToolResponse("stratigraphy.list", structuredTamper, publicKey, now),
    false,
  );
  assert.equal(verifyToolResponse("proof.list", signed, publicKey, now), false);
  assert.equal(
    verifyToolResponse(
      "stratigraphy.list",
      signed,
      generateKeyPairSync("ed25519").publicKey,
      now,
    ),
    false,
  );
  assert.equal(
    verifyToolResponse("stratigraphy.list", signed, publicKey, now + 301),
    false,
  );
  assert.equal(
    verifyToolResponse("stratigraphy.list", signed, publicKey, now - 301),
    false,
  );
  for (const [field, value] of [
    ["algorithm", "HMAC"],
    ["keyId", "wrong"],
    ["timestamp", now + 1],
    ["contentSha256", "00".repeat(32)],
    ["signature", "v1," + "A".repeat(88)],
    ["signature", "v1a,not-base64"],
    ["timestamp", "1792454400"],
  ]) {
    const altered = clone();
    (altered._meta!.responseSignature as any)[field as string] = value;
    assert.equal(
      verifyToolResponse("stratigraphy.list", altered, publicKey, now),
      false,
    );
  }
  assert.equal(
    verifyToolResponse("stratigraphy.list", output(), publicKey, now),
    false,
  );
});

test("error tool results remain unsigned and cannot verify", () => {
  const error = { ...output(), isError: true };
  assert.equal(
    signToolResponse("stratigraphy.list", error, privateKey, now),
    error,
  );
  assert.equal(
    verifyToolResponse("stratigraphy.list", error, publicKey, now),
    false,
  );
});
