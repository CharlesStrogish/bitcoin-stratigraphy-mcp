import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  finalizeEvent,
  nip19,
  SimplePool,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];
const RELAY_TIMEOUT_MS = 10_000;

function parsePrivateKey(value: string | undefined): Uint8Array {
  if (!value) {
    throw new Error(
      "NOSTR_PRIVATE_KEY is required as a 64-character hex key or nsec",
    );
  }
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error(
    "NOSTR_PRIVATE_KEY must be a 64-character hex key or valid nsec",
  );
}

function configuredRelays(value: string | undefined): string[] {
  const candidates = value
    ? value
        .split(",")
        .map((relay) => relay.trim())
        .filter(Boolean)
    : DEFAULT_RELAYS;
  const relays = [...new Set(candidates)];
  assert.ok(relays.length > 0, "At least one Nostr relay is required");
  for (const relay of relays) {
    assert.equal(
      new URL(relay).protocol,
      "wss:",
      `Nostr relay must use wss: ${relay}`,
    );
  }
  return relays;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildTestAttestation(secretKey: Uint8Array) {
  const createdAt = Math.floor(Date.now() / 1_000);
  const identifier = `bitcoin-stratigraphy:test:zk-attestation:${createdAt}:${randomUUID()}`;
  const snapshotCids = {
    dataset: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3niosu7u4tfuvq3xiw7gwd6jm",
    proof: "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  };
  const metadata = {
    schema: "bitcoin-stratigraphy/zk-snark-proof-attestation-test/v1",
    test: true,
    proof: {
      system: "groth16",
      curve: "bn128",
      verification_key_id: "bitcoin-stratigraphy-test-v1",
      proof_sha256: sha256(`test-proof:${identifier}`),
      public_inputs_sha256: sha256(`test-public-inputs:${identifier}`),
    },
    snapshot_cids: snapshotCids,
    created_at: createdAt,
  };
  const content = JSON.stringify(metadata);
  const contentHash = sha256(content);
  const template: EventTemplate = {
    kind: 30078,
    created_at: createdAt,
    content,
    tags: [
      ["d", identifier],
      ["c", "zk-snark-proof-attestation"],
      ["timestamp", String(createdAt)],
      ["x", contentHash],
      ["r", `ipfs://${snapshotCids.dataset}`],
      ["r", `ipfs://${snapshotCids.proof}`],
    ],
  };
  const event = finalizeEvent(template, secretKey);
  assert.ok(verifyEvent(event), "Locally signed Nostr event failed verification");
  return { event, identifier, metadata, contentHash };
}

function assertFetchedEvent(
  fetched: Event,
  expected: ReturnType<typeof buildTestAttestation>,
) {
  assert.equal(fetched.id, expected.event.id, "Fetched event ID changed");
  assert.ok(verifyEvent(fetched), "Fetched event signature is invalid");
  assert.equal(fetched.kind, 30078, "Fetched event kind is not NIP-78");
  assert.equal(fetched.pubkey, expected.event.pubkey, "Fetched pubkey changed");
  assert.equal(fetched.content, expected.event.content, "Fetched content changed");
  assert.deepEqual(
    JSON.parse(fetched.content),
    expected.metadata,
    "Fetched attestation metadata changed",
  );
  assert.ok(
    fetched.tags.some(
      ([name, value]) => name === "d" && value === expected.identifier,
    ),
    "Fetched event is missing its d tag",
  );
  assert.ok(
    fetched.tags.some(
      ([name, value]) => name === "c" && value === "zk-snark-proof-attestation",
    ),
    "Fetched event is missing its category tag",
  );
  assert.ok(
    fetched.tags.some(
      ([name, value]) =>
        name === "timestamp" && value === String(expected.event.created_at),
    ),
    "Fetched event is missing its timestamp tag",
  );
  assert.ok(
    fetched.tags.some(
      ([name, value]) => name === "x" && value === expected.contentHash,
    ),
    "Fetched event content hash tag changed",
  );
}

async function main() {
  const relays = configuredRelays(process.env.NOSTR_RELAYS);
  const secretKey = parsePrivateKey(process.env.NOSTR_PRIVATE_KEY);
  const attestation = buildTestAttestation(secretKey);
  const pool = new SimplePool();

  console.log(`Publishing NIP-78 test event ${attestation.event.id}`);
  console.log(`Relays: ${relays.join(", ")}`);

  try {
    const acknowledgements = await Promise.allSettled(
      pool.publish(relays, attestation.event, { maxWait: RELAY_TIMEOUT_MS }),
    );
    const publishResults = acknowledgements.map((result, index) => ({
      relay: relays[index],
      ok: result.status === "fulfilled",
      response:
        result.status === "fulfilled"
          ? result.value
          : result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
    }));
    console.log("\nRelay OK responses:");
    console.table(publishResults);

    const acceptedRelays = publishResults
      .filter(({ ok }) => ok)
      .map(({ relay }) => relay);
    assert.ok(
      acceptedRelays.length > 0,
      "No configured relay returned a successful OK response",
    );

    const queryResults = await Promise.all(
      acceptedRelays.map(async (relay) => {
        const byId = await pool.querySync(
          [relay],
          { ids: [attestation.event.id] },
          { maxWait: RELAY_TIMEOUT_MS },
        );
        const events =
          byId.length > 0
            ? byId
            : await pool.querySync(
                [relay],
                {
                  kinds: [30078],
                  authors: [attestation.event.pubkey],
                  "#d": [attestation.identifier],
                },
                { maxWait: RELAY_TIMEOUT_MS },
              );
        const fetched = events.find(({ id }) => id === attestation.event.id);
        if (fetched) assertFetchedEvent(fetched, attestation);
        return { relay, queryable: Boolean(fetched) };
      }),
    );
    console.log("\nRelay query results:");
    console.table(queryResults);
    assert.ok(
      queryResults.some(({ queryable }) => queryable),
      "The event could not be queried back from any relay that accepted it",
    );

    console.log(
      `\nNIP-78 broadcast verified: ${acceptedRelays.length}/${relays.length} relays acknowledged; content integrity confirmed on read-back.`,
    );
  } finally {
    pool.destroy();
  }
}

main().catch((error: unknown) => {
  console.error("\nNostr NIP-78 verification failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});