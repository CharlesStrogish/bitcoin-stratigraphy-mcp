import { createHash } from "node:crypto";
import {
  finalizeEvent,
  nip19,
  SimplePool,
  type Event,
  type EventTemplate,
} from "nostr-tools";

export const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
] as const;

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

export function parsePrivateKey(value: string): Uint8Array {
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

export async function publishNip78Attestation(
  payload: unknown,
): Promise<"broadcast_confirmed" | "broadcast_failed" | "not_configured"> {
  if (!process.env.NOSTR_PRIVATE_KEY) return "not_configured";
  const attestation = signTelemetryPayload(payload);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(
      pool.publish([...DEFAULT_NOSTR_RELAYS], attestation.event, {
        maxWait: 3_000,
      }),
    );
    return results.some((result) => result.status === "fulfilled")
      ? "broadcast_confirmed"
      : "broadcast_failed";
  } finally {
    pool.destroy();
  }
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
  const cache = new Map<
    string,
    { createdAt: number | undefined; signed: object }
  >();
  const maxEntries = 2_048;
  return <T extends object>(payload: T, createdAt?: number) => {
    const { attestation: _previous, ...unsigned } = payload as T & {
      attestation?: unknown;
    };
    const serialized = JSON.stringify(unsigned);
    if (serialized === undefined) {
      throw new TypeError("Nostr attestation payload must be JSON serializable");
    }
    const cached = cache.get(serialized);
    if (cached && cached.createdAt === createdAt) {
      cache.delete(serialized);
      cache.set(serialized, cached);
      return cached.signed as T & { attestation: NostrAttestation };
    }
    const signed = attest(unsigned, createdAt);
    cache.delete(serialized);
    cache.set(serialized, { createdAt, signed });
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
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