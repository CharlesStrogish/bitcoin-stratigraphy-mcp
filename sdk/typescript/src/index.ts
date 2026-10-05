import { Buffer } from "node:buffer";
export type SubscriptionTier = "1-day" | "30-day";
export type AgentTier = "STANDARD" | "VIP" | "SWARM";
export type SettlementAsset =
  | "btc-lightning"
  | "l-btc"
  | "taproot-assets";

export type AgentReputationMetadata = {
  pubkey: string;
  tier: AgentTier;
  discount_percent: number;
  rate_limit_multiplier: number;
};

export type NostrAttestation = {
  protocol: "nostr";
  nip: 78;
  payload_sha256: string;
  event: {
    id: string;
    pubkey: string;
    created_at: number;
    kind: 30078;
    tags: string[][];
    content: string;
    sig: string;
  };
};

export type ZkPublicInputs = {
  blockHeight: number;
  snapshotDigest: string;
  thermodynamicHash: string;
  timestamp: number;
  valuationSat: number;
};

export type ZkProof = {
  proof: string;
  publicInputs: ZkPublicInputs;
  verificationKeyId: string;
};

export type ZkVerifyResponse = {
  valid: boolean;
  verifiedAt: string;
  computationTimeMs: number;
};

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

export type MeshSchnorrVerifier = (event: {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 20078;
  tags: string[][];
  content: string;
  sig: string;
}) => boolean | Promise<boolean>;

export type MeshConsensusValidation = {
  valid: boolean;
  quorumReached: boolean;
  validAttestationCount: number;
};

export type MeshValidationPolicy = {
  trustedPubkeys: ReadonlySet<string> | readonly string[];
  threshold: number;
  networkId: string;
  allowIsolation?: boolean;
  nowMs?: number;
  maxAgeSeconds?: number;
};

export type StratigraphyEntry = {
  day: number;
  title: string;
  video_id: string;
  transcript_summary: string;
  quantitative_alpha: {
    target_multiplier: number;
    difficulty_epoch_progress: string;
    thermodynamic_signal: string;
  };
  attestation?: NostrAttestation;
};

export type PaidStratigraphyResponse = {
  data: StratigraphyEntry[];
  zkProof: ZkProof;
  meshConsensus: MeshConsensus;
};

export type StratigraphyTelemetry = {
  observed_at: string;
  block: { height: number | null };
  difficulty: {
    epoch_progress_percent: number;
    estimated_adjustment_percent: number | null;
  };
  market: {
    usd_per_btc: number | null;
    sats_per_usd: number | null;
  };
  thermodynamic: {
    signal: string;
    target_multiplier: number;
  };
  attestation?: NostrAttestation;
};

export type StratigraphyTelemetryEnvelope = {
  data: StratigraphyTelemetry;
  zkProof: ZkProof;
  meshConsensus: MeshConsensus;
};

export type CostDiscovery = {
  protocol: "L402";
  settlement_asset: SettlementAsset;
  supported_assets: SettlementAsset[];
  available_assets: SettlementAsset[];
  access_tiers: Array<{
    id: SubscriptionTier;
    duration_days: number;
    price_sats: number;
    original_price_sats: number;
    discount_sats: number;
    discount_percent: number;
    base_price_sats: number;
    max_price_sats: number;
    multiplier: number;
  }>;
  agent?: AgentReputationMetadata;
  dynamic_pricing: {
    difficulty_epoch_progress: number;
    request_velocity_rpm: number;
    calculated_at: string;
  };
  legacy_query_pricing: {
    sats_per_day: number;
    minimum_sats: number;
  };
  dataset: {
    days: number;
    first_day: number;
    last_day: number;
    grows_over_time: boolean;
  };
  mcp_tool: {
    name: string;
    parameters: Record<string, unknown>;
  };
  response_schema: Record<string, unknown>;
};

export type L402WalletAdapter = {
  payInvoice(
    invoice: string,
  ): Promise<string | { preimage: string } | { payment_preimage: string }>;
};

export type NwcPaymentClient = {
  payInvoice(input: { invoice: string }): Promise<unknown>;
  close?(): void;
};

export class NwcWalletAdapter implements L402WalletAdapter {
  constructor(private readonly client: NwcPaymentClient) {}

  async payInvoice(invoice: string): Promise<string> {
    // Some clients unwrap the NIP-47 envelope; others return it intact.
    const response = await this.client.payInvoice({ invoice });
    return paymentPreimage(response);
  }

  close(): void {
    this.client.close?.();
  }
}

export type CachedL402Credential = {
  macaroon: string;
  preimage: string;
  validUntil: number;
  tier: SubscriptionTier;
  paymentAsset?: SettlementAsset;
};

export type CredentialStore = {
  get(key: string): CachedL402Credential | undefined;
  set(key: string, value: CachedL402Credential): void;
  delete(key: string): void;
};

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, CachedL402Credential>();

  get(key: string): CachedL402Credential | undefined {
    return this.values.get(key);
  }

  set(key: string, value: CachedL402Credential): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

export type StreamSubscription = {
  close(): void;
  readonly closed: boolean;
};

export type BitcoinStratigraphyClientOptions = {
  baseUrl: string;
  wallet: L402WalletAdapter;
  tier?: SubscriptionTier;
  settlementAsset?: SettlementAsset;
  fetch?: typeof globalThis.fetch;
  credentialStore?: CredentialStore;
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  nip98?: {
    pubkey: string;
    signAuthorization(input: {
      url: string;
      method: string;
      payload?: string;
    }): string | Promise<string>;
  };
};

type L402Pass = {
  tier: SubscriptionTier;
  invoice: string;
  payment_hash: string;
  macaroon: string;
  valid_until: number;
  price_sats: number;
  original_price_sats: number;
  discount_sats: number;
  discount_percent: number;
  agent_tier: AgentTier;
  payment_asset: SettlementAsset;
};

type L402Challenge = {
  invoice: string;
  payment_hash: string;
  settlement_asset: SettlementAsset;
  supported_assets: SettlementAsset[];
  available_assets: SettlementAsset[];
  agent?: AgentReputationMetadata;
  passes: L402Pass[];
};

export class BitcoinStratigraphyClient {
  private readonly baseUrl: string;
  private readonly wallet: L402WalletAdapter;
  private readonly tier: SubscriptionTier;
  private readonly settlementAsset: SettlementAsset;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly credentials: CredentialStore;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly nip98?: BitcoinStratigraphyClientOptions["nip98"];
  private paymentInFlight?: Promise<CachedL402Credential>;

  constructor(options: BitcoinStratigraphyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.wallet = options.wallet;
    this.tier = options.tier ?? "1-day";
    this.settlementAsset = options.settlementAsset ?? "btc-lightning";
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.credentials = options.credentialStore ?? new MemoryCredentialStore();
    this.initialReconnectDelayMs = options.reconnect?.initialDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
    if (
      options.nip98 &&
      !/^[0-9a-f]{64}$/.test(options.nip98.pubkey)
    ) {
      throw new Error("NIP-98 pubkey must be 64 lowercase hexadecimal characters");
    }
    this.nip98 = options.nip98;
  }

  async getCost(): Promise<CostDiscovery> {
    return this.fetchJson<CostDiscovery>("/api/v1/cost");
  }

  async getLatest(): Promise<PaidStratigraphyResponse> {
    await this.getCost();
    return this.authorizedJson<PaidStratigraphyResponse>("/api/v1/stratigraphy");
  }

  async getMeshStatus(): Promise<MeshStatus> {
    return this.fetchJson<MeshStatus>("/api/v1/mesh/status");
  }

  async verifyZkProof(
    input: ZkProof,
    data: unknown,
  ): Promise<ZkVerifyResponse> {
    const payload: {
      proof: string;
      publicInputs: ZkPublicInputs;
      verificationKeyId: string;
      data: unknown;
    } = {
      proof: input.proof,
      publicInputs: input.publicInputs,
      verificationKeyId: input.verificationKeyId,
      data,
    };
    const response = await this.fetcher(`${this.baseUrl}/api/v1/zk/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw await httpError(response);
    return parseJson<ZkVerifyResponse>(response);
  }

  subscribeStream(
    onTelemetry: (telemetry: StratigraphyTelemetryEnvelope) => void,
    onError: (error: unknown) => void = () => undefined,
  ): StreamSubscription {
    const controller = new AbortController();
    let closed = false;

    const run = async () => {
      let reconnectDelay = this.initialReconnectDelayMs;
      while (!controller.signal.aborted) {
        try {
          const response = await this.authorizedResponse(
            "/api/v1/stratigraphy/stream",
            controller.signal,
          );
          reconnectDelay = this.initialReconnectDelayMs;
          await consumeSse(response, onTelemetry, controller.signal);
          if (!controller.signal.aborted) {
            throw new Error("Bitcoin Stratigraphy stream closed");
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          onError(error);
          try {
            await this.sleep(reconnectDelay, controller.signal);
          } catch {
            break;
          }
          reconnectDelay = Math.min(
            reconnectDelay * 2,
            this.maxReconnectDelayMs,
          );
        }
      }
    };
    void run();

    return {
      close() {
        if (closed) return;
        closed = true;
        controller.abort();
      },
      get closed() {
        return closed;
      },
    };
  }

  private credentialKey(): string {
    const assetScope =
      this.settlementAsset === "btc-lightning"
        ? `${this.baseUrl}:${this.tier}`
        : `${this.baseUrl}:${this.tier}:${this.settlementAsset}`;
    return this.nip98 ? `${assetScope}:${this.nip98.pubkey}` : assetScope;
  }

  private currentCredential(): CachedL402Credential | undefined {
    const key = this.credentialKey();
    const credential = this.credentials.get(key);
    if (!credential) return undefined;
    if (credential.validUntil <= Math.floor(this.now() / 1_000)) {
      this.credentials.delete(key);
      return undefined;
    }
    return credential;
  }

  private authorization(credential: CachedL402Credential): string {
    return `L402 ${credential.macaroon}:${credential.preimage}`;
  }

  private async requestHeaders(
    path: string,
    credential?: CachedL402Credential,
  ): Promise<HeadersInit | undefined> {
    const l402 = credential ? this.authorization(credential) : undefined;
    if (!this.nip98) {
      return {
        ...(l402 ? { Authorization: l402 } : {}),
        "X-Settlement-Asset": this.settlementAsset,
      };
    }
    const url = `${this.baseUrl}${path}`;
    const nip98 = await this.nip98.signAuthorization({
      url,
      method: "GET",
    });
    if (!/^Nostr\s+\S+$/.test(nip98)) {
      throw new Error("NIP-98 signer returned an invalid authorization value");
    }
    return l402
      ? {
          Authorization: l402,
          "X-Nostr-Authorization": nip98,
          "X-Settlement-Asset": this.settlementAsset,
        }
      : {
          Authorization: nip98,
          "X-Settlement-Asset": this.settlementAsset,
        };
  }

  private async authorizedJson<T>(path: string): Promise<T> {
    const response = await this.authorizedResponse(path);
    return parseJson<T>(response);
  }

  private async authorizedResponse(
    path: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let credential = this.currentCredential();
    let sentAuthorization = credential
      ? this.authorization(credential)
      : undefined;
    let response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: await this.requestHeaders(path, credential),
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      const current = this.currentCredential();
      if (
        !current ||
        this.authorization(current) === sentAuthorization
      ) {
        this.credentials.delete(this.credentialKey());
      }
      credential = undefined;
    }
    if (response.status !== 402 && response.ok) return response;
    if (response.status !== 402) throw await httpError(response);

    const newerCredential = this.currentCredential();
    if (
      newerCredential &&
      this.authorization(newerCredential) !== sentAuthorization
    ) {
      credential = newerCredential;
      sentAuthorization = this.authorization(credential);
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        headers: await this.requestHeaders(path, credential),
        signal,
      });
      if (response.ok) return response;
      if (response.status !== 402) throw await httpError(response);
    }

    const challenge = await parseJson<L402Challenge>(response);
    credential = await this.payChallenge(challenge);
    response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: await this.requestHeaders(path, credential),
      signal,
    });
    if (!response.ok) throw await httpError(response);
    return response;
  }

  private payChallenge(
    challenge: L402Challenge,
  ): Promise<CachedL402Credential> {
    if (this.paymentInFlight) return this.paymentInFlight;
    const selected = challenge.passes.find((pass) => pass.tier === this.tier);
    if (
      !selected ||
      typeof selected.invoice !== "string" ||
      typeof selected.macaroon !== "string" ||
      typeof selected.valid_until !== "number" ||
      selected.payment_asset !== this.settlementAsset ||
      !/^[0-9a-fA-F]{64}$/.test(selected.payment_hash)
    ) {
      throw new Error(`L402 challenge did not include tier ${this.tier}`);
    }
    this.paymentInFlight = this.wallet
      .payInvoice(selected.invoice)
      .then(async (result) => {
        const preimage = paymentPreimage(result);
        const isCoinosReference =
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(preimage);
        if (isCoinosReference && selected.payment_asset !== "btc-lightning") {
          throw new Error("CoinOS payment references require Lightning settlement");
        }
        if (!isCoinosReference &&
            await sha256Hex(preimage) !== selected.payment_hash.toLowerCase()) {
          throw new Error(
            "Wallet preimage does not match the L402 payment hash",
          );
        }
        const credential = {
          macaroon: selected.macaroon,
          preimage,
          validUntil: selected.valid_until,
          tier: selected.tier,
          paymentAsset: selected.payment_asset,
        };
        this.credentials.set(this.credentialKey(), credential);
        return credential;
      })
      .finally(() => {
        this.paymentInFlight = undefined;
      });
    return this.paymentInFlight;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: await this.requestHeaders(path),
    });
    if (!response.ok) throw await httpError(response);
    return parseJson<T>(response);
  }
}

function paymentPreimage(value: unknown): string {
  const isBufferJson = (candidate: unknown): candidate is { type: "Buffer"; data: unknown[] } =>
    candidate !== null && typeof candidate === "object" &&
    "type" in candidate && candidate.type === "Buffer" &&
    "data" in candidate && Array.isArray(candidate.data);
  const fields: Array<[string, unknown]> = [];
  if (typeof value === "string" || value instanceof Uint8Array || isBufferJson(value)) {
    fields.push(["response", value]);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const response = value as Record<string, unknown>;
    const result = response.result;
    if (result instanceof Uint8Array || isBufferJson(result)) fields.push(["result", result]);
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      const nested = result as Record<string, unknown>;
      fields.push(["result.preimage", nested.preimage]);
      fields.push(["result.payment_preimage", nested.payment_preimage]);
    }
    fields.push(["preimage", response.preimage]);
    fields.push(["payment_preimage", response.payment_preimage]);
  }
  const describe = (field: unknown) => {
    if (typeof field === "string") {
      const text = field.trim();
      const hex = text.replace(/^0x/i, "");
      const encoded = text.replace(/-/g, "+").replace(/_/g, "/");
      // Node's Base64 decoder accepts malformed strings; require a canonical
      // encoding before interpreting any payment proof as bytes.
      const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(encoded) &&
        encoded.length % 4 !== 1 &&
        Buffer.from(encoded, "base64").toString("base64").replace(/=+$/, "") ===
          encoded.replace(/=+$/, "");
      return {
        metadata: { typeof: "string", length: field.length, isBase64, isHex: /^[0-9a-f]+$/i.test(hex) },
        bytes: /^[0-9a-f]{64}$/i.test(hex)
          ? Buffer.from(hex, "hex")
          : isBase64 ? Buffer.from(encoded, "base64") : undefined,
      };
    }
    if (field instanceof Uint8Array) {
      return {
        metadata: { typeof: "object", length: field.byteLength, isBase64: false, isHex: false },
        bytes: Buffer.from(field),
      };
    }
    if (field !== null && typeof field === "object" && !Array.isArray(field)) {
      const json = field as Record<string, unknown>;
      if (isBufferJson(json)) {
        const data = json.data;
        const valid = data.every((byte: unknown) =>
          Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255);
        return {
          metadata: { typeof: "object", length: data.length, isBase64: false, isHex: false },
          bytes: valid ? Buffer.from(data as number[]) : undefined,
        };
      }
    }
    return { metadata: { typeof: field === null ? "null" : typeof field, length: null, isBase64: false, isHex: false }, bytes: undefined };
  };
  const descriptions = fields.map(([name, field]) => ({ name, field, ...describe(field) }));
  for (const { field, bytes } of descriptions) {
    if (bytes?.length === 32) return bytes.toString("hex");
    if (typeof field === "string" &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(field.trim())) {
      return field.trim().toLowerCase();
    }
  }
  // Only structural metadata; never print the raw response or payment proof.
  const shape = descriptions.map(({ name, metadata }) =>
    `${name}:${JSON.stringify(metadata)}`).join(", ") || "no recognizable fields";
  throw new Error(`Wallet did not return a 32-byte payment preimage or CoinOS payment reference (${shape})`);
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(`Invalid JSON response from ${response.url || "server"}`, {
      cause: error,
    });
  }
}

async function httpError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(
    `Bitcoin Stratigraphy request failed (${response.status})${body ? `: ${body}` : ""}`,
  );
}

async function consumeSse(
  response: Response,
  onTelemetry: (telemetry: StratigraphyTelemetryEnvelope) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("SSE response did not include a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = "";
  let buffer = "";
  const appendChunk = (chunk: string, flush = false) => {
    rawBuffer += chunk;
    const keepTrailingCarriageReturn = !flush && rawBuffer.endsWith("\r");
    const processable = keepTrailingCarriageReturn
      ? rawBuffer.slice(0, -1)
      : rawBuffer;
    rawBuffer = keepTrailingCarriageReturn ? "\r" : "";
    buffer += processable.replace(/\r\n|\r/g, "\n");
  };
  const dispatchFrames = () => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseFrame(frame);
      if (event.type === "telemetry" && event.data) {
        onTelemetry(JSON.parse(event.data) as StratigraphyTelemetryEnvelope);
      }
      boundary = buffer.indexOf("\n\n");
    }
  };
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      appendChunk(decoder.decode(value, { stream: true }));
      dispatchFrames();
    }
    appendChunk(decoder.decode(), true);
    dispatchFrames();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSseFrame(frame: string): { type: string; data: string } {
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { type, data: data.join("\n") };
}

function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function sha256Hex(hexValue: string): Promise<string> {
  const bytes = Uint8Array.from(
    hexValue.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalMeshValue(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["bool", value ? 1 : 0];
  if (typeof value === "string") return ["str", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite mesh number");
    const bytes = new ArrayBuffer(8);
    new DataView(bytes).setFloat64(0, value, false);
    return [
      "f64",
      Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ];
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

async function meshMerkleRoot(eventIds: string[]): Promise<string> {
  if (eventIds.length === 0) return sha256Text("");
  let level = [...eventIds].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        await sha256Text(level[index]! + (level[index + 1] ?? level[index]!)),
      );
    }
    level = next;
  }
  return level[0]!;
}

export async function validateMeshConsensus(
  consensus: MeshConsensus,
  snapshot: unknown,
  verifySchnorr: MeshSchnorrVerifier,
  policy: MeshValidationPolicy,
): Promise<MeshConsensusValidation> {
  let serialized: string;
  try {
    serialized = canonicalMeshJson(snapshot);
  } catch {
    return { valid: false, quorumReached: false, validAttestationCount: 0 };
  }
  const snapshotDigest = await sha256Text(serialized);
  const trustedPubkeys = new Set(policy.trustedPubkeys);
  const effectiveThreshold =
    consensus.isolationMode && policy.allowIsolation ? 1 : policy.threshold;
  const nowSeconds = Math.floor((policy.nowMs ?? Date.now()) / 1_000);
  const maxAgeSeconds = policy.maxAgeSeconds ?? 300;
  const uniquePubkeys = new Set<string>();
  let validAttestationCount = 0;
  for (const attestation of consensus.peerAttestations) {
    if (
      uniquePubkeys.has(attestation.pubkey) ||
      !trustedPubkeys.has(attestation.pubkey) ||
      !/^[0-9a-f]{64}$/.test(attestation.pubkey) ||
      !/^[0-9a-f]{64}$/.test(attestation.eventId) ||
      !/^[0-9a-f]{128}$/.test(attestation.signature) ||
      Math.abs(nowSeconds - attestation.createdAt) > maxAgeSeconds
    ) {
      continue;
    }
    uniquePubkeys.add(attestation.pubkey);
    const event = {
      id: attestation.eventId,
      pubkey: attestation.pubkey,
      created_at: attestation.createdAt,
      kind: 20078 as const,
      tags: [
        ["d", `bitcoin-stratigraphy-mesh:${snapshotDigest}`],
        ["t", "bitcoin-stratigraphy"],
        ["t", "mesh-cross-validation"],
        ["x", snapshotDigest],
        ["n", policy.networkId],
      ],
      content: canonicalMeshJson({
        networkId: policy.networkId,
        snapshotDigest,
      }),
      sig: attestation.signature,
    };
    if (await verifySchnorr(event)) validAttestationCount += 1;
  }
  const quorumReached = validAttestationCount >= effectiveThreshold;
  const root =
    await meshMerkleRoot(consensus.peerAttestations.map((item) => item.eventId));
  const score = Math.min(1, validAttestationCount / effectiveThreshold);
  return {
    valid:
      snapshotDigest === consensus.snapshotDigest &&
      consensus.networkId === policy.networkId &&
      consensus.threshold === effectiveThreshold &&
      (!consensus.isolationMode || policy.allowIsolation === true) &&
      root === consensus.merkleRoot &&
      Math.abs(score - consensus.quorumScore) < Number.EPSILON &&
      quorumReached,
    quorumReached,
    validAttestationCount,
  };
}