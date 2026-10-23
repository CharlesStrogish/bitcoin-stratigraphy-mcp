import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { issuerKeyId, signArticle12Receipt, signIssuerPayload } from "../../src/lib/article12-signature";
import { signRevocationSnapshot } from "../../src/routes/compliance";

const corePath = resolve(process.cwd(), "../bitcoin-stratigraphy-dashboard/public/static/receipt-verifier.js");
const source = readFileSync(corePath, "utf8");
type Verifier = {
  verify(input: unknown, pem: string | string[], expected: string, snapshot?: unknown, now?: number): Promise<Record<string, unknown>>;
  verifyRevocationSnapshot(input: unknown, pem: string | string[], expected: string, now?: number): Promise<Record<string, unknown>>;
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

test("rotation verifies current and historical receipts against only independent pins", async () => {
  const rotated = generateKeyPairSync("ed25519");
  const newPem = rotated.publicKey.export({ type: "spki", format: "pem" }).toString();
  const oldReceipt = signArticle12Receipt(fixture(), privateKey);
  const newReceipt = signArticle12Receipt(fixture(), rotated.privateKey);
  for (const pins of [[pem, newPem], pem + "\n" + newPem, JSON.stringify([pem, newPem])]) {
    assert.equal((await verifier.verify(oldReceipt, pins, agent)).issuerKeyId, issuerKeyId(privateKey));
    assert.equal((await verifier.verify(newReceipt, pins, agent)).issuerKeyId, issuerKeyId(rotated.privateKey));
  }
  await assert.rejects(verifier.verify(newReceipt, pem, agent), /fingerprint/);
  await assert.rejects(verifier.verify(oldReceipt, newPem, agent), /fingerprint/);
  // Legacy signed v1 receipts without signed rotation metadata remain readable.
  const legacy = signIssuerPayload(fixture(), privateKey, "article12-ed25519-v1", "bitcoin-stratigraphy/article12/v1\n");
  assert.equal((await verifier.verify(legacy, pem, agent)).verified, true);
  const mismatch = signIssuerPayload({ ...fixture(), issuer_key_id: "00".repeat(32) },
    privateKey, "article12-ed25519-v1", "bitcoin-stratigraphy/article12/v1\n");
  await assert.rejects(verifier.verify(mismatch, pem, agent), /fingerprint/);
});

test("signed CRL verifies as-of non-revocation, current rotation and optional historical receipts", async () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const rotated = generateKeyPairSync("ed25519");
  const newPem = rotated.publicKey.export({ type: "spki", format: "pem" }).toString();
  const snapshot = signRevocationSnapshot({ as_of: new Date(now).toISOString(), revoked_keys: [
    { pubkey: "01".repeat(32), revoked_at: "2026-10-22T00:00:00.000Z" },
  ] }, rotated.privateKey);
  const receipt = signArticle12Receipt(fixture(), privateKey);
  const result = await verifier.verify(receipt, [pem, newPem], agent, JSON.stringify(snapshot), now + 1);
  assert.equal(result.verified, true);
  assert.equal((result.revocation as Record<string, unknown>).status, "not_revoked_in_snapshot");
  assert.equal((result.revocation as Record<string, unknown>).asOf, "2026-10-23T12:00:00.000Z");
  await assert.rejects(verifier.verify(receipt, pem, agent, snapshot, now), /Revocation.*fingerprint/);
  await assert.rejects(verifier.verify(receipt, [pem, newPem], agent, snapshot, now - 1), /future-dated/);
  await assert.rejects(verifier.verify(receipt, [pem, newPem], agent, snapshot, now + 900000), /stale/);
  const revoked = signRevocationSnapshot({ as_of: new Date(now).toISOString(), revoked_keys: [
    { pubkey: agent, revoked_at: new Date(now).toISOString() },
  ] }, rotated.privateKey);
  await assert.rejects(verifier.verify(receipt, [pem, newPem], agent, revoked, now), /Agent is revoked/);
  // Revocation at audit time is distinct from valid historical execution evidence.
  assert.equal((await verifier.verify(receipt, pem, agent)).verified, true);
  assert.equal((await verifier.verify(receipt, pem, agent)).revocation, null);
  await assert.rejects(verifier.verifyRevocationSnapshot({ ...snapshot, revoked_keys: [] }, newPem, agent, now), /signature/);
  await assert.rejects(verifier.verifyRevocationSnapshot("not-json", newPem, agent, now), /Revocation/);
  await assert.rejects(verifier.verifyRevocationSnapshot(receipt, pem, agent, now), /Missing supported/);
});

test("even valid signatures cannot bless malformed, incomplete or unbounded CRL evidence", async () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const base = { snapshot_type: "nip98-revocation-snapshot-v1",
    as_of: new Date(now).toISOString(), next_update: new Date(now + 900000).toISOString(),
    issuer_key_id: issuerKeyId(privateKey), revoked_keys: [] };
  for (const change of [
    { revoked_keys: undefined }, { revoked_keys: {} }, { issuer_key_id: "00".repeat(32) },
    { next_update: new Date(now + 86400000).toISOString() }, { as_of: "invalid" },
    { revoked_keys: [{ pubkey: "bad", revoked_at: new Date(now).toISOString() }] },
    { revoked_keys: [{ pubkey: "01".repeat(32), revoked_at: new Date(now + 1).toISOString() }] },
    { revoked_keys: Array(2).fill({ pubkey: "01".repeat(32), revoked_at: new Date(now).toISOString() }) },
  ]) {
    const snapshot = signIssuerPayload({ ...base, ...change }, privateKey,
      "nip98-crl-ed25519-v1", "bitcoin-stratigraphy/nip98-crl/v1\n");
    await assert.rejects(verifier.verifyRevocationSnapshot(snapshot, pem, agent, now), /Revocation/);
  }
});
