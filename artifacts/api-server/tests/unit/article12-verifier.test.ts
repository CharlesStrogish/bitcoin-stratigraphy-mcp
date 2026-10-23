import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { signArticle12Receipt } from "../../src/lib/article12-signature";

const corePath = resolve(process.cwd(), "../bitcoin-stratigraphy-dashboard/public/static/receipt-verifier.js");
const source = readFileSync(corePath, "utf8");
type Verifier = {
  verify(input: unknown, pem: string, expected: string): Promise<Record<string, unknown>>;
  canonical(value: unknown): string;
};
const context = { crypto: webcrypto, TextEncoder, Uint8Array, atob,
  Article12Verifier: undefined as Verifier | undefined };
runInNewContext(source, context);
const verifier = context.Article12Verifier!;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
const agent = "ab".repeat(32);
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest();
const leafHash = (data: Buffer) => sha(Buffer.concat([Buffer.from([0]), data]));
const nodeHash = (left: Buffer, right: Buffer) => sha(Buffer.concat([Buffer.from([1]), left, right]));

function fixture(attributed = true, traced = true): Record<string, unknown> {
  const traceparent = "00-" + "12".repeat(16) + "-" + "34".repeat(8) + "-01";
  const attribution = attributed ? { agent_authentication: "nip98", agent_id: agent } : {};
  const leaf = Buffer.concat([
    sha("task"), sha("trace"), sha("result"),
    ...((attributed || traced) ? [sha(verifier.canonical(attribution))] : []),
    ...(traced ? [sha(verifier.canonical({ traceparent }))] : []),
  ]);
  return {
    escrow_id: "test-escrow", timestamp: "2026-10-22T00:00:00Z",
    receipt_type: "article_12_execution_commitment",
    leaf_index: 0, tree_size: 1, audit_path: [],
    leaf_preimage: leaf.toString("hex"),
    execution_leaf_hash: leafHash(leaf).toString("hex"),
    merkle_root: leafHash(leaf).toString("hex"),
    ...attribution, ...(traced ? { traceparent } : {}),
  };
}

test("offline Web Crypto verifies Node Ed25519 signature, trace-aware Merkle evidence and pinned agent", async () => {
  for (const traced of [true, false]) {
    const receipt = signArticle12Receipt(fixture(true, traced), privateKey);
    for (const input of [receipt, { article_12_receipt: receipt }, { proof: receipt }]) {
      const result = await verifier.verify(JSON.stringify(input), pem, agent.toUpperCase());
      assert.equal(result.verified, true);
      assert.equal(result.identity, true);
      assert.equal(result.merkle, true);
      assert.equal(result.signature, true);
    }
  }
});

test("offline verifier refuses unsigned receipts, untrusted keys and signature tampering", async () => {
  const unsigned = fixture();
  await assert.rejects(verifier.verify(unsigned, pem, agent), /Missing supported/);
  const receipt = signArticle12Receipt(unsigned, privateKey);
  const wrongKey = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" }).toString();
  await assert.rejects(verifier.verify(receipt, wrongKey, agent), /fingerprint/);
  await assert.rejects(verifier.verify({ ...receipt, escrow_id: "changed" }, pem, agent), /signature is invalid/);
  await assert.rejects(verifier.verify(receipt, pem, "cd".repeat(32)), /expected NIP-98/);
  await assert.rejects(verifier.verify(receipt, pem, ""), /expected 64-character/);
});

test("validly signed but corrupt proofs, forged attribution and downgraded identity fail closed", async () => {
  for (const [changes, error] of [
    [{ merkle_root: "00".repeat(32) }, /Merkle inclusion/],
    [{ tree_size: 2 }, /Merkle inclusion/],
    [{ audit_path: ["00".repeat(32)] }, /extra siblings/],
    [{ leaf_index: 1 }, /bounds/],
    [{ execution_leaf_hash: "00".repeat(32) }, /leaf hash/],
    [{ leaf_preimage: "00".repeat(160) }, /leaf hash/],
    [{ agent_id: "cd".repeat(32) }, /attribution/],
    [{ agent_authentication: "other" }, /layout/],
    [{ traceparent: "00-" + "ff".repeat(16) + "-" + "34".repeat(8) + "-01" }, /Trace context/],
  ] as const) {
    const receipt = signArticle12Receipt({ ...fixture(), ...changes }, privateKey);
    await assert.rejects(verifier.verify(receipt, pem, agent), error);
  }
  for (const traced of [true, false]) {
    const receipt = signArticle12Receipt(fixture(false, traced), privateKey);
    await assert.rejects(verifier.verify(receipt, pem, agent), /expected NIP-98/);
  }
  await assert.rejects(verifier.verify(signArticle12Receipt({
    ...fixture(), agent_authentication: undefined,
  }, privateKey), pem, agent), /attribution/);
});

function tree(leaves: Buffer[]): Buffer {
  if (leaves.length === 1) return leaves[0]!;
  const split = 2 ** Math.floor(Math.log2(leaves.length - 1));
  return nodeHash(tree(leaves.slice(0, split)), tree(leaves.slice(split)));
}
function path(leaves: Buffer[], index: number): Buffer[] {
  if (leaves.length === 1) return [];
  const split = 2 ** Math.floor(Math.log2(leaves.length - 1));
  if (index < split) return [...path(leaves.slice(0, split), index), tree(leaves.slice(split))];
  return [...path(leaves.slice(split), index - split), tree(leaves.slice(0, split))];
}

test("RFC 6962 verification covers all positions in balanced and non-power-of-two trees", async () => {
  const unsigned = fixture();
  for (let size = 1; size <= 17; size++) {
    for (let index = 0; index < size; index++) {
      const leaves = Array.from({ length: size }, (_, i) =>
        i === index ? Buffer.from(unsigned.execution_leaf_hash as string, "hex") : leafHash(sha(`leaf-${i}`)));
      const receipt = signArticle12Receipt({ ...unsigned, tree_size: size, leaf_index: index,
        merkle_root: tree(leaves).toString("hex"),
        audit_path: path(leaves, index).map(entry => entry.toString("hex")),
      }, privateKey);
      assert.equal((await verifier.verify(receipt, pem, agent)).verified, true, `size=${size}, index=${index}`);
    }
  }
});

test("downloadable verifier embeds the tested core without network dependencies", () => {
  const html = readFileSync(resolve(process.cwd(), "../bitcoin-stratigraphy-dashboard/public/static/verify.html"), "utf8");
  assert.ok(html.includes(source), "HTML must embed the exact tested verifier core");
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=["']https?:/i);
  assert.doesNotMatch(html, /\bfetch\s*\(|\bXMLHttpRequest\b|\blocalStorage\b|\bsessionStorage\b/);
});
