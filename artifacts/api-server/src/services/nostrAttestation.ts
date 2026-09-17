import { createHash } from "node:crypto";
import {
  finalizeEvent,
  nip19,
  type Event,
  type EventTemplate,
} from "nostr-tools";

export type NostrAttestation = {
  protocol: "nostr";
  nip: 78;
  payload_sha256: string;
  event: Event;
};

export type NostrAttestor = <T extends object>(
  payload: T,
  createdAt?: number,
) => T & { attestation: NostrAttestation };

function parsePrivateKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error("NOSTR_PRIVATE_KEY must be a 64-character hex key or nsec");
}

export function signTelemetryPayload(
  payload: unknown,
  options: {
    privateKey?: string;
    createdAt?: number;
  } = {},
): NostrAttestation {
  const privateKey = options.privateKey ?? process.env.NOSTR_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("NOSTR_PRIVATE_KEY is not configured");
  }
  return signWithKey(
    payload,
    parsePrivateKey(privateKey),
    options.createdAt,
  );
}

function signWithKey(
  payload: unknown,
  privateKey: Uint8Array,
  createdAt?: number,
): NostrAttestation {
  const content = JSON.stringify(payload);
  if (content === undefined) {
    throw new TypeError("Nostr attestation payload must be JSON serializable");
  }
  const payloadSha256 = createHash("sha256").update(content).digest("hex");
  const template: EventTemplate = {
    kind: 30078,
    created_at: createdAt ?? Math.floor(Date.now() / 1_000),
    tags: [
      ["d", `bitcoin-stratigraphy:${payloadSha256}`],
      ["t", "bitcoin-stratigraphy"],
      ["t", "telemetry"],
      ["x", payloadSha256],
    ],
    content,
  };
  return {
    protocol: "nostr",
    nip: 78,
    payload_sha256: payloadSha256,
    event: finalizeEvent(template, privateKey),
  };
}

export function createNostrAttestor(
  privateKey = process.env.NOSTR_PRIVATE_KEY,
): NostrAttestor {
  if (!privateKey) {
    throw new Error("NOSTR_PRIVATE_KEY is not configured");
  }
  const parsedKey = parsePrivateKey(privateKey);
  return <T extends object>(payload: T, createdAt?: number) => {
    const { attestation: _previous, ...unsigned } = payload as T & {
      attestation?: unknown;
    };
    const serialized = JSON.stringify(unsigned);
    if (serialized === undefined) {
      throw new TypeError("Nostr attestation payload must be JSON serializable");
    }
    const detached = JSON.parse(serialized) as T;
    return {
      ...detached,
      attestation: signWithKey(detached, parsedKey, createdAt),
    } as T & { attestation: NostrAttestation };
  };
}

export function createCachedNostrAttestor(
  attest: NostrAttestor,
): NostrAttestor {
  const cache = new Map<string, object>();
  return <T extends object>(payload: T, createdAt?: number) => {
    const { attestation: _previous, ...unsigned } = payload as T & {
      attestation?: unknown;
    };
    const cacheKey = JSON.stringify(unsigned);
    if (cacheKey === undefined) {
      throw new TypeError("Nostr attestation payload must be JSON serializable");
    }
    const cached = cache.get(cacheKey);
    if (cached) return cached as T & { attestation: NostrAttestation };
    const signed = attest(unsigned, createdAt);
    cache.set(cacheKey, signed);
    return signed as T & { attestation: NostrAttestation };
  };
}

export function attachNostrAttestation<T extends object>(
  payload: T,
  options: {
    privateKey?: string;
    createdAt?: number;
  } = {},
): T & { attestation: NostrAttestation } {
  return createNostrAttestor(
    options.privateKey ?? process.env.NOSTR_PRIVATE_KEY,
  )(payload, options.createdAt);
}