import { createHash } from "node:crypto";
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools";

const HEX_32 = /^[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_MS = 1_500;
const ACTIVE_PEER_WINDOW_MS = 60_000;
const MAX_ATTESTATION_AGE_SECONDS = 300;
const MESH_EVENT_KIND = 20_078;
const DEFAULT_NETWORK_ID = "bitcoin-stratigraphy-mainnet-v1";

export type MeshPeerAttestation = {
  pubkey: string;
  signature: string;
  eventId: string;
  createdAt: number;
  roundTripLatencyMs: number;
};

export type MeshConsensus = {
  quorumScore: number;
  peerAttestations: MeshPeerAttestation[];
  merkleRoot: string;
  snapshotDigest: string;
  threshold: number;
  isolationMode: boolean;
  networkId: string;
};

export type MeshStatus = {
  nodePubkey: string;
  activePeerCount: number;
  configuredPeerCount: number;
  topologyHealth: "healthy" | "degraded" | "isolated";
  crossValidationSuccessRate: number;
  averagePropagationLatencyMs: number;
  quorumThreshold: number;
};

type PeerState = {
  url: string;
  pubkey: string;
  lastValidatedAt?: number;
  latencyMs?: number;
};

export type MeshGossipServiceOptions = {
  privateKey?: string;
  peers?: Array<string | { url: string; pubkey: string }>;
  threshold?: number;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  networkId?: string;
};

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

function normalizePeerUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
  ) {
    throw new Error("Mesh peer URLs must use HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

function canonicalMeshValue(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["bool", value ? 1 : 0];
  if (typeof value === "string") return ["str", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Mesh snapshot numbers must be finite");
    }
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    return ["f64", bytes.toString("hex")];
  }
  if (Array.isArray(value)) {
    return ["array", value.map(canonicalMeshValue)];
  }
  if (typeof value === "object") {
    return [
      "object",
      Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalMeshValue(item)]),
    ];
  }
  throw new TypeError("Mesh snapshot must be JSON serializable");
}

export function canonicalMeshJson(value: unknown): string {
  return JSON.stringify(canonicalMeshValue(value));
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalMeshJson(value)).digest("hex");
}

function hashPair(left: string, right: string): string {
  return createHash("sha256").update(left + right).digest("hex");
}

export function meshMerkleRoot(eventIds: string[]): string {
  if (eventIds.length === 0) return createHash("sha256").update("").digest("hex");
  let level = [...eventIds].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(hashPair(level[index]!, level[index + 1] ?? level[index]!));
    }
    level = next;
  }
  return level[0]!;
}

function eventTemplate(
  snapshotDigest: string,
  networkId: string,
  createdAt: number,
): EventTemplate {
  return {
    kind: MESH_EVENT_KIND,
    created_at: createdAt,
    tags: [
      ["d", `bitcoin-stratigraphy-mesh:${snapshotDigest}`],
      ["t", "bitcoin-stratigraphy"],
      ["t", "mesh-cross-validation"],
      ["x", snapshotDigest],
      ["n", networkId],
    ],
    content: canonicalMeshJson({ networkId, snapshotDigest }),
  };
}

export function verifyMeshAttestationEvent(
  event: Event,
  snapshotDigest: string,
  expectedPubkey?: string,
  networkId = DEFAULT_NETWORK_ID,
  nowMs = Date.now(),
): boolean {
  return (
    HEX_32.test(snapshotDigest) &&
    event.kind === MESH_EVENT_KIND &&
    HEX_32.test(event.pubkey) &&
    (expectedPubkey === undefined || event.pubkey === expectedPubkey) &&
    Math.abs(Math.floor(nowMs / 1_000) - event.created_at) <=
      MAX_ATTESTATION_AGE_SECONDS &&
    event.content === canonicalMeshJson({ networkId, snapshotDigest }) &&
    event.tags.some(
      (tag) => tag.length === 2 && tag[0] === "x" && tag[1] === snapshotDigest,
    ) &&
    event.tags.some(
      (tag) =>
        tag.length === 2 &&
        tag[0] === "d" &&
        tag[1] === `bitcoin-stratigraphy-mesh:${snapshotDigest}`,
    ) &&
    event.tags.some(
      (tag) => tag.length === 2 && tag[0] === "n" && tag[1] === networkId,
    ) &&
    verifyEvent(event)
  );
}

function validSourceAttestation(
  value: unknown,
  nowMs: number,
  expectedPubkey: string,
): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const attestation = candidate.attestation as
    | { payload_sha256?: unknown; event?: Event }
    | undefined;
  if (!attestation?.event || typeof attestation.payload_sha256 !== "string") {
    return false;
  }
  const { attestation: _ignored, ...unsigned } = candidate;
  const content = JSON.stringify(unsigned);
  return (
    attestation.event.kind === 30_078 &&
    attestation.event.pubkey === expectedPubkey &&
    Math.abs(Math.floor(nowMs / 1_000) - attestation.event.created_at) <=
      MAX_ATTESTATION_AGE_SECONDS &&
    attestation.event.content === content &&
    attestation.event.tags.some(
      (tag) => tag[0] === "t" && tag[1] === "bitcoin-stratigraphy",
    ) &&
    attestation.event.tags.some(
      (tag) => tag[0] === "t" && tag[1] === "telemetry",
    ) &&
    attestation.event.tags.some(
      (tag) =>
        tag[0] === "x" && tag[1] === attestation.payload_sha256,
    ) &&
    createHash("sha256").update(content).digest("hex") ===
      attestation.payload_sha256 &&
    verifyEvent(attestation.event)
  );
}

function validGossipedSnapshot(
  snapshot: unknown,
  nowMs: number,
  expectedPubkey: string,
): boolean {
  return Array.isArray(snapshot)
    ? snapshot.length > 0 &&
        snapshot.every((item) =>
          validSourceAttestation(item, nowMs, expectedPubkey),
        )
    : validSourceAttestation(snapshot, nowMs, expectedPubkey);
}

export class MeshQuorumError extends Error {
  constructor(readonly received: number, readonly required: number) {
    super(
      `Mesh quorum unavailable: received ${received} of ${required} attestations`,
    );
    this.name = "MeshQuorumError";
  }
}

export class MeshGossipService {
  readonly nodePubkey: string;
  readonly networkId: string;
  private readonly privateKey: Uint8Array;
  private readonly peers: PeerState[];
  private readonly thresholdOverride?: number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private validationAttempts = 0;
  private validationSuccesses = 0;
  private propagationLatencyTotal = 0;
  private propagationLatencySamples = 0;

  constructor(options: MeshGossipServiceOptions = {}) {
    const privateKey = options.privateKey ?? process.env.NOSTR_PRIVATE_KEY;
    if (!privateKey) throw new Error("NOSTR_PRIVATE_KEY is not configured");
    this.privateKey = parsePrivateKey(privateKey);
    this.nodePubkey = getPublicKey(this.privateKey);
    this.networkId =
      options.networkId ??
      process.env.MESH_NETWORK_ID?.trim() ??
      DEFAULT_NETWORK_ID;
    const inputs =
      options.peers ??
      (process.env.MESH_PEERS ?? "")
        .split(",")
        .map((peer) => peer.trim())
        .filter(Boolean);
    this.peers = inputs.map((peer) => {
      if (typeof peer !== "string") {
        if (!HEX_32.test(peer.pubkey)) {
          throw new Error("Mesh peer pubkeys must be lowercase 64-hex values");
        }
        return { url: normalizePeerUrl(peer.url), pubkey: peer.pubkey };
      }
      const separator = peer.lastIndexOf("|");
      const pubkey = peer.slice(separator + 1);
      if (separator < 1 || !HEX_32.test(pubkey)) {
        throw new Error(
          "MESH_PEERS entries must use https://node.example|<64-hex-pubkey>",
        );
      }
      return { url: normalizePeerUrl(peer.slice(0, separator)), pubkey };
    });
    if (new Set(this.peers.map((peer) => peer.pubkey)).size !== this.peers.length) {
      throw new Error("Mesh peer pubkeys must be unique");
    }
    this.thresholdOverride = options.threshold;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get quorumThreshold(): number {
    const nodeCount = this.peers.length + 1;
    return Math.max(
      1,
      Math.min(
        nodeCount,
        this.thresholdOverride ?? Math.floor(nodeCount / 2) + 1,
      ),
    );
  }

  signDigest(snapshotDigest: string, createdAt?: number): Event {
    if (!HEX_32.test(snapshotDigest)) {
      throw new Error("Snapshot digest must be lowercase 64-hex");
    }
    return finalizeEvent(
      eventTemplate(
        snapshotDigest,
        this.networkId,
        createdAt ?? Math.floor(this.now() / 1_000),
      ),
      this.privateKey,
    );
  }

  attestSnapshot(input: {
    snapshot: unknown;
    snapshotDigest: string;
    networkId: string;
    originPubkey: string;
  }): Event {
    if (
      input.networkId !== this.networkId ||
      !this.peers.some((peer) => peer.pubkey === input.originPubkey) ||
      digestJson(input.snapshot) !== input.snapshotDigest ||
      !validGossipedSnapshot(input.snapshot, this.now(), input.originPubkey)
    ) {
      throw new Error("Mesh snapshot validation failed");
    }
    return this.signDigest(input.snapshotDigest);
  }

  async discoverPeers(): Promise<Array<{ url: string; pubkey: string }>> {
    const discovered = await Promise.all(
      this.peers.map(async (peer) => {
        try {
          const response = await this.fetchWithTimeout(
            `${peer.url}/api/v1/mesh/status`,
            { headers: { Accept: "application/json" } },
          );
          if (!response.ok) return undefined;
          const body = (await response.json()) as { nodePubkey?: unknown };
          if (body.nodePubkey !== peer.pubkey || peer.pubkey === this.nodePubkey) {
            return undefined;
          }
          return { url: peer.url, pubkey: peer.pubkey };
        } catch {
          return undefined;
        }
      }),
    );
    return discovered.filter(
      (peer): peer is { url: string; pubkey: string } => peer !== undefined,
    );
  }

  async createConsensus(snapshot: unknown): Promise<MeshConsensus> {
    const snapshotDigest = digestJson(snapshot);
    const localEvent = this.signDigest(snapshotDigest);
    const attestations: MeshPeerAttestation[] = [
      {
        pubkey: localEvent.pubkey,
        signature: localEvent.sig,
        eventId: localEvent.id,
        createdAt: localEvent.created_at,
        roundTripLatencyMs: 0,
      },
    ];
    const discovered = await this.discoverPeers();
    this.validationAttempts += this.peers.length;
    const peerResults = await Promise.all(
      discovered.map(async (peer) => {
        const startedAt = this.now();
        try {
          const response = await this.fetchWithTimeout(
            `${peer.url}/api/v1/mesh/attest`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                snapshot,
                snapshotDigest,
                networkId: this.networkId,
                originPubkey: this.nodePubkey,
              }),
            },
          );
          if (!response.ok) return undefined;
          const body = (await response.json()) as { event?: Event };
          if (
            !body.event ||
            !verifyMeshAttestationEvent(
              body.event,
              snapshotDigest,
              peer.pubkey,
              this.networkId,
              this.now(),
            )
          ) {
            return undefined;
          }
          const latency = Math.max(0, this.now() - startedAt);
          const state = this.peers.find((candidate) => candidate.url === peer.url);
          if (state) {
            state.lastValidatedAt = this.now();
            state.latencyMs = latency;
          }
          this.validationSuccesses += 1;
          this.propagationLatencyTotal += latency;
          this.propagationLatencySamples += 1;
          return {
            pubkey: body.event.pubkey,
            signature: body.event.sig,
            eventId: body.event.id,
            createdAt: body.event.created_at,
            roundTripLatencyMs: latency,
          };
        } catch {
          return undefined;
        }
      }),
    );
    for (const result of peerResults) {
      if (
        result &&
        !attestations.some((attestation) => attestation.pubkey === result.pubkey)
      ) {
        attestations.push(result);
      }
    }
    const threshold = this.quorumThreshold;
    if (this.peers.length > 0 && attestations.length < threshold) {
      throw new MeshQuorumError(attestations.length, threshold);
    }
    return {
      quorumScore: Math.min(1, attestations.length / threshold),
      peerAttestations: attestations,
      merkleRoot: meshMerkleRoot(
        attestations.map((attestation) => attestation.eventId),
      ),
      snapshotDigest,
      threshold,
      isolationMode: this.peers.length === 0,
      networkId: this.networkId,
    };
  }

  status(): MeshStatus {
    const activeNeighbors = this.peers.filter(
      (peer) =>
        peer.lastValidatedAt !== undefined &&
        this.now() - peer.lastValidatedAt <= ACTIVE_PEER_WINDOW_MS,
    ).length;
    const activePeerCount = activeNeighbors + 1;
    return {
      nodePubkey: this.nodePubkey,
      activePeerCount,
      configuredPeerCount: this.peers.length,
      topologyHealth:
        this.peers.length === 0
          ? "isolated"
          : activePeerCount >= this.quorumThreshold
            ? "healthy"
            : "degraded",
      crossValidationSuccessRate:
        this.validationAttempts === 0
          ? this.peers.length === 0
            ? 1
            : 0
          : this.validationSuccesses / this.validationAttempts,
      averagePropagationLatencyMs:
        this.propagationLatencySamples === 0
          ? 0
          : this.propagationLatencyTotal / this.propagationLatencySamples,
      quorumThreshold: this.quorumThreshold,
    };
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetcher(input, {
        ...init,
        signal: controller.signal,
        redirect: "error",
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createMeshGossipService(
  options: MeshGossipServiceOptions = {},
): MeshGossipService {
  return new MeshGossipService(options);
}