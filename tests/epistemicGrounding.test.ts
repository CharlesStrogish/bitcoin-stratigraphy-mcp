import assert from "node:assert/strict";
import test from "node:test";
import { getPublicKey } from "nostr-tools";
import {
  fetchCurrentBitcoinTip,
  groundEpistemicContext,
  verifyEpistemicAnchorReceipt,
} from "../artifacts/api-server/src/services/epistemicGrounding";
import {
  verifyCryptographicAttestation,
} from "../artifacts/api-server/src/services/attestation";

const PRIVATE_KEY = "01".padStart(64, "0");
const BLOCK_HASH = "ab".repeat(32);

test("fetches and validates the current Bitcoin height and hash", async () => {
  const requested: string[] = [];
  const tip = await fetchCurrentBitcoinTip({
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      return new Response(
        url.endsWith("/blocks/tip/height") ? "920001" : BLOCK_HASH,
      );
    },
    baseUrl: "https://bitcoin.example/api",
  });
  assert.deepEqual(tip, {
    height: 920001,
    hash: BLOCK_HASH,
    source: "https://bitcoin.example/api",
  });
  assert.deepEqual(requested, [
    "https://bitcoin.example/api/blocks/tip/height",
    "https://bitcoin.example/api/block-height/920001",
  ]);
});

test("grounds context into a publicly verifiable epistemic anchor", async () => {
  const receipt = await groundEpistemicContext(
    {
      contextHash: "cd".repeat(32),
      agentId: "test-agent",
      metadata: { topic: "difficulty-adjustment" },
    },
    {
      now: () => 1_790_000_000_000,
      privateKey: PRIVATE_KEY,
      readBitcoinTip: async () => ({
        height: 920001,
        hash: BLOCK_HASH,
        source: "https://bitcoin.example/api",
      }),
    },
  );
  assert.equal(receipt.receiptSchema, "bitcoin-stratigraphy/epistemic-anchor/v1");
  assert.equal(receipt.contextHash, "cd".repeat(32));
  assert.equal(receipt.blockHeight, 920001);
  assert.equal(receipt.blockHash, BLOCK_HASH);
  assert.equal(receipt.merkleRoot, receipt.proof.merkleRoot);
  assert.equal(receipt.timestamp, 1_790_000_000_000);
  assert.equal(receipt.nostrSignature, receipt.signature);
  const issuerPublicKey = getPublicKey(
    Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")),
  );
  assert.equal(
    verifyEpistemicAnchorReceipt(receipt, { issuerPublicKey }),
    true,
  );
  assert.equal(
    verifyCryptographicAttestation({
      ...receipt,
      payload: {
        ...(receipt.payload as Record<string, unknown>),
        contextHash: "ef".repeat(32),
      },
    }, { issuerPublicKey }),
    false,
  );
  for (const [field, replacement] of [
    ["contextHash", "ef".repeat(32)],
    ["blockHash", "12".repeat(32)],
    ["merkleRoot", "34".repeat(32)],
    ["timestamp", receipt.timestamp + 1],
  ] as const) {
    assert.equal(
      verifyEpistemicAnchorReceipt(
        { ...receipt, [field]: replacement },
        { issuerPublicKey },
      ),
      false,
      `${field} alias tampering must invalidate the receipt`,
    );
  }
});

test("rejects invalid grounding inputs and injected Bitcoin tips", async () => {
  await assert.rejects(
    groundEpistemicContext(
      { contextHash: "not-hex", agentId: "agent" },
      {
        privateKey: PRIVATE_KEY,
        readBitcoinTip: async () => ({
          height: 920001,
          hash: BLOCK_HASH,
          source: "https://bitcoin.example/api",
        }),
      },
    ),
    /contextHash/,
  );
  await assert.rejects(
    groundEpistemicContext(
      { contextHash: "cd".repeat(32), agentId: "agent" },
      {
        privateKey: PRIVATE_KEY,
        readBitcoinTip: async () => ({
          height: 0,
          hash: BLOCK_HASH,
          source: "injected",
        }),
      },
    ),
    /invalid grounding data/,
  );
});