import {
  getEventHash,
  nip19,
  SimplePool,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";
import { DEFAULT_NOSTR_RELAYS } from "./nostrAttestation";

const HEX_KEY = /^[0-9a-f]{64}$/;
const SESSION_KIND = 20_079;
const VOUCH_KIND = 30_079;
const MAX_AGE_SECONDS = 300;

export type AgentIdentity = {
  pubkey: string;
  isValidSignature: boolean;
  attestationCount: number;
  trustScore: number;
  firstSeenTimestamp: number | null;
  attestationDepth: number | null;
  metadata: { name?: string; about?: string };
};

export type IdentityInput = {
  pubkey?: string;
  event?: Event;
  signature?: string;
};

export function normalizeNostrPubkey(value: string): string {
  if (HEX_KEY.test(value)) return value;
  if (value.startsWith("npub1")) {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub") return decoded.data;
  }
  throw new Error("pubkey must be a lowercase 64-character hex key or npub");
}

function validEvent(event: unknown): event is Event {
  if (!event || typeof event !== "object") return false;
  const candidate = event as Partial<Event>;
  if (
    !HEX_KEY.test(candidate.pubkey ?? "") ||
    !HEX_KEY.test(candidate.id ?? "") ||
    !/^[0-9a-f]{128}$/.test(candidate.sig ?? "") ||
    !Number.isSafeInteger(candidate.kind) ||
    !Number.isSafeInteger(candidate.created_at) ||
    typeof candidate.content !== "string" ||
    !Array.isArray(candidate.tags) ||
    !candidate.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((item) => typeof item === "string"),
    )
  ) {
    return false;
  }
  // Build an unmarked event: nostr-tools may cache verification on an Event object.
  try {
    const clean: Event = {
      id: candidate.id!,
      pubkey: candidate.pubkey!,
      sig: candidate.sig!,
      kind: candidate.kind!,
      created_at: candidate.created_at!,
      content: candidate.content!,
      tags: candidate.tags!.map((tag) => [...tag]),
    };
    return getEventHash(clean) === clean.id && verifyEvent(clean);
  } catch {
    return false;
  }
}

export function verifyAgentSessionEvent(
  event: unknown,
  content:
    | { networkId: string; snapshotDigest: string }
    | { networkId: string; date: string },
  nowMs = Date.now(),
): event is Event {
  return (
    validEvent(event) &&
    event.kind === SESSION_KIND &&
    Math.abs(Math.floor(nowMs / 1_000) - event.created_at) <= MAX_AGE_SECONDS &&
    event.content === JSON.stringify(content)
  );
}

type EventLoader = (filter: Filter) => Promise<Event[]>;
export class NostrWebOfTrust {
  private readonly trusted: Set<string>;
  private readonly loadEvents: EventLoader;
  private readonly now: () => number;
  constructor(options: {
    trustedPubkeys: string[];
    loadEvents?: EventLoader;
    relays?: string[];
    networkId: string;
    now?: () => number;
  }) {
    this.trusted = new Set(options.trustedPubkeys.map(normalizeNostrPubkey));
    this.now = options.now ?? Date.now;
    const relays = options.relays ?? [...DEFAULT_NOSTR_RELAYS];
    this.loadEvents =
      options.loadEvents ??
      (async (filter) => {
        const pool = new SimplePool();
        try {
          return await pool.querySync(relays, filter, { maxWait: 1_500 });
        } finally {
          pool.close(relays);
        }
      });
    this.networkId = options.networkId;
  }
  readonly networkId: string;

  async verify(input: IdentityInput): Promise<AgentIdentity> {
    if (input.signature !== undefined && !input.event) {
      throw new Error("A Schnorr signature requires the complete NIP-01 event");
    }
    const signedEvent =
      input.event && input.signature
        ? { ...input.event, sig: input.signature }
        : input.event;
    const pubkey = input.pubkey
      ? normalizeNostrPubkey(input.pubkey)
      : signedEvent?.pubkey
        ? normalizeNostrPubkey(signedEvent.pubkey)
        : (() => {
            throw new Error("pubkey or signed event is required");
          })();
    const isValidSignature =
      !!signedEvent &&
      validEvent(signedEvent) &&
      signedEvent.pubkey === pubkey &&
      (input.event?.sig === undefined ||
        input.signature === undefined ||
        input.signature === input.event.sig);
    const result: AgentIdentity = {
      pubkey,
      isValidSignature,
      attestationCount: 0,
      trustScore: 0,
      firstSeenTimestamp: isValidSignature ? signedEvent!.created_at : null,
      attestationDepth: null,
      metadata: {},
    };
    if (input.event && !isValidSignature) return result;
    if (this.trusted.has(pubkey)) {
      result.trustScore = 1;
      result.attestationDepth = 0;
    }
    const from = Math.floor(this.now() / 1_000) - 90 * 86_400;
    const until = Math.floor(this.now() / 1_000) + 300;
    const [metadata, direct] = await Promise.all([
      this.loadEvents({ kinds: [0], authors: [pubkey], limit: 30 }),
      this.loadEvents({
        kinds: [VOUCH_KIND],
        authors: [...this.trusted],
        "#p": [pubkey],
        since: from,
        until,
        limit: 200,
      }),
    ]);
    const profile = metadata.filter(
      (event) =>
        validEvent(event) &&
        event.pubkey === pubkey &&
        event.kind === 0 &&
        event.created_at <= until &&
        event.created_at >= 0 &&
        event.content.length <= 4_096,
    );
    if (profile.length) {
      result.firstSeenTimestamp = Math.min(
        result.firstSeenTimestamp ?? Infinity,
        ...profile.map((event) => event.created_at),
      );
      try {
        const fields = JSON.parse(
          profile.sort((a, b) => b.created_at - a.created_at)[0]!.content,
        );
        if (fields && typeof fields === "object") {
          for (const field of ["name", "about"] as const) {
            if (typeof fields[field] === "string")
              result.metadata[field] = fields[field].slice(0, 256);
          }
        }
      } catch {
        /* Ignore malformed, signed profile content. */
      }
    }
    const isVouch = (event: Event, author: string, target: string) =>
      validEvent(event) &&
      event.kind === VOUCH_KIND &&
      event.pubkey === author &&
      event.created_at >= from &&
      event.created_at <= until &&
      event.tags.some(
        (tag) => tag.length === 2 && tag[0] === "p" && tag[1] === target,
      ) &&
      event.tags.some(
        (tag) =>
          tag.length === 2 && tag[0] === "n" && tag[1] === this.networkId,
      );
    const directAuthors = new Set(
      direct
        .filter(
          (event) =>
            this.trusted.has(event.pubkey) &&
            isVouch(event, event.pubkey, pubkey),
        )
        .map((event) => event.pubkey),
    );
    result.attestationCount = directAuthors.size;
    if (directAuthors.size) result.attestationDepth = 1;
    // Only a directly trusted signature can introduce an intermediary.
    const introductions = await this.loadEvents({
      kinds: [VOUCH_KIND],
      authors: [...this.trusted],
      since: from,
      until,
      limit: 200,
    });
    const intermediaries = new Set(
      introductions
        .filter(
          (event) =>
            this.trusted.has(event.pubkey) &&
            validEvent(event) &&
            event.kind === VOUCH_KIND &&
            event.created_at >= from &&
            event.created_at <= until &&
            event.tags.some(
              (tag) =>
                tag.length === 2 && tag[0] === "n" && tag[1] === this.networkId,
            ),
        )
        .flatMap((event) =>
          event.tags
            .filter(
              (tag) =>
                tag.length === 2 &&
                tag[0] === "p" &&
                HEX_KEY.test(tag[1]!) &&
                tag[1] !== pubkey &&
                !this.trusted.has(tag[1]!),
            )
            .map((tag) => tag[1]!),
        ),
    );
    if (intermediaries.size) {
      const indirect = await this.loadEvents({
        kinds: [VOUCH_KIND],
        authors: [...intermediaries].slice(0, 100),
        "#p": [pubkey],
        since: from,
        until,
        limit: 200,
      });
      const indirectAuthors = new Set(
        indirect
          .filter(
            (event) =>
              intermediaries.has(event.pubkey) &&
              isVouch(event, event.pubkey, pubkey),
          )
          .map((event) => event.pubkey),
      );
      result.attestationCount += indirectAuthors.size;
      if (indirectAuthors.size && result.attestationDepth === null)
        result.attestationDepth = 2;
      result.trustScore = Math.min(
        1,
        result.trustScore +
          directAuthors.size * 0.6 +
          indirectAuthors.size * 0.2,
      );
    } else {
      result.trustScore = Math.min(
        1,
        result.trustScore + directAuthors.size * 0.6,
      );
    }
    return result;
  }
}
