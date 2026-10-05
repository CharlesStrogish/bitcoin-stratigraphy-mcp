/**
 * Dependency-free, one-shot L402 client for the Bitcoin Stratigraphy MCP endpoint.
 * Each paid tool call has its own path-bound, single-use credential; do not cache it.
 */
export const DEFAULT_MCP_SERVER_URL =
  "https://bitcoin-stratigraphy-dashboard.replit.app/mcp";

export type WalletPayment =
  | string
  | { preimage: string }
  | { payment_preimage: string };
/** Return a 32-byte Lightning preimage, or a CoinOS internal-payment UUID for server-side verification. */
export type WalletHandler = (invoice: string) => Promise<WalletPayment>;

export type X402PaymentRequirements = {
  scheme: "exact";
  network: "eip155:8453";
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    paymentFlow: "upfront";
    name: "USD Coin";
    version: "2";
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type X402PaymentTerms = {
  x402Version: 2;
  accepted: X402PaymentRequirements;
  resource: { url: string; [key: string]: unknown };
};
/** Agent signer returns the base64-encoded x402 PAYMENT-SIGNATURE envelope. */
export type X402WalletHandler = (terms: X402PaymentTerms) => Promise<string>;
export type StratigraphyClientOptions = {
  /** Optional legacy Lightning/CoinOS wallet, used for L402 challenges. */
  wallet?: WalletHandler;
  /** Agent signer used for x402 v2 exact payments. */
  x402Wallet?: X402WalletHandler;
  /** Maximum exact payment in integer micro-USDC. Required when x402Wallet is configured. */
  maxPaymentMicroUsdc?: string | number;
  fetcher?: typeof fetch;
};

export type MetricName =
  | "target_multiplier"
  | "difficulty_epoch_progress"
  | "thermodynamic_signal";
export type TelemetryRecord = {
  day: number;
  title: string;
  video_id: string;
  transcript_summary: string;
  quantitative_alpha: Partial<{
    target_multiplier: number;
    difficulty_epoch_progress: string;
    thermodynamic_signal: string;
  }>;
};
export type ProofLifecycle = "verified" | "cached" | "pending" | "invalid";
export type PublicInputs = {
  blockHeight: number;
  snapshotDigest: string;
  thermodynamicHash: string;
  timestamp: number;
  valuationSat: number;
};
export type Groth16Coordinates = {
  piA: [string, string, string];
  piB: [[string, string], [string, string], [string, string]];
  piC: [string, string, string];
};
export type ProofAttestation = {
  proofHash: string;
  snapshotDigest: string;
  status: ProofLifecycle;
  submittedAt: string;
  attestationCount: number;
  meshQuorum: boolean;
};
export type GroundReceipt = {
  receiptSchema: string;
  contextHash: string;
  agentId: string;
  blockHeight: number;
  blockHash: string;
  merkleRoot: string;
  timestamp: number;
  schema: string;
  payload: Record<string, unknown>;
  proof: Record<string, unknown>;
  signature: Record<string, unknown>;
  nostrSignature: Record<string, unknown>;
  [key: string]: unknown;
};

export type McpToolArguments = {
  "stratigraphy.get": {
    days?: number;
    date?: string;
    blockHeight?: number;
    metrics?: MetricName[];
    startDate?: string;
    endDate?: string;
    startBlock?: number;
    endBlock?: number;
    limit?: number;
  };
  "stratigraphy.list": Record<string, never>;
  "stratigraphy.get_digest": {
    target?: string;
    format?: "compact" | "minimal" | "kv";
  };
  "stratigraphy.get_diff": { fromTarget: string; toTarget?: string };
  "stratigraphy.get_range": {
    startTarget: string;
    endTarget?: string;
    limit?: number;
    format?: "compact" | "minimal" | "kv";
  };
  /** @deprecated Use stratigraphy.get_digest. */
  "stratigraphy.digest": McpToolArguments["stratigraphy.get_digest"];
  /** @deprecated Use stratigraphy.get_diff. */
  "stratigraphy.diff": McpToolArguments["stratigraphy.get_diff"];
  /** @deprecated Use stratigraphy.get_range. */
  "stratigraphy.range": McpToolArguments["stratigraphy.get_range"];
  "proof.verify":
    | {
    proofType?: "groth16";
    proof: string;
    publicInputs: PublicInputs;
    verificationKeyId: string;
    data: Record<string, unknown> | Record<string, unknown>[];
  }
    | { proofType: "ots"; otsProof: string; targetHash: string };
  "payment.get_info":
    | { action?: "query"; toolName?: string }
    | ({ action: "settle" } & (
      | { paymentHash: string; preimage: string; txHash?: never }
      | { paymentHash: string; txHash: string; preimage?: never }
    ));
  /** @deprecated Use payment.get_info. */
  "payment.info": McpToolArguments["payment.get_info"];
  "proof.get_status":
    | { proofHash: string; snapshotDigest?: never; receiptHash?: never }
    | { snapshotDigest: string; proofHash?: never; receiptHash?: never }
    | { receiptHash: string; proofHash?: never; snapshotDigest?: never };
  /** @deprecated Use proof.get_status. */
  "proof.status":
    | { proofHash: string; snapshotDigest?: never; receiptHash?: never }
    | { snapshotDigest: string; proofHash?: never; receiptHash?: never }
    | { receiptHash: string; proofHash?: never; snapshotDigest?: never };
  "proof.list": { limit?: number; offset?: number; status?: ProofLifecycle };
  "proof.submit": {
    proof: Groth16Coordinates;
    publicSignals: [string, string, string, string, string];
    snapshotDigest?: string;
  };
  "proof.ground": {
    contextHash: string;
    agentId: string;
    metadata?: Record<string, unknown>;
  };
  "mesh.get_status": Record<string, never>;
  /** @deprecated Use mesh.get_status. */
  "mesh.status": Record<string, never>;
  "proof.issue_receipt": {
    cid: string;
    nostrEventId?: string;
    context?: Record<string, unknown>;
  };
  /** @deprecated Use proof.issue_receipt. */
  "proof.epistemic_receipt": {
    cid: string;
    nostrEventId?: string;
    context?: Record<string, unknown>;
  };
  "mesh.broadcast": {
    signalType: "telemetry_snapshot";
    payload: { date: string };
  };
};

export type McpToolResponses = {
  "stratigraphy.get": { records: TelemetryRecord[] };
  "stratigraphy.list": {
    totalSnapshots: number;
    oldestBlock: number;
    newestBlock: number;
    availableMetrics: string[];
    dateBounds: { startDate: string; endDate: string };
  };
  "stratigraphy.get_digest": Record<string, unknown>;
  "stratigraphy.get_diff": Record<string, unknown>;
  "stratigraphy.get_range": Record<string, unknown>;
  /** @deprecated Use stratigraphy.get_digest. */
  "stratigraphy.digest": McpToolResponses["stratigraphy.get_digest"];
  /** @deprecated Use stratigraphy.get_diff. */
  "stratigraphy.diff": McpToolResponses["stratigraphy.get_diff"];
  /** @deprecated Use stratigraphy.get_range. */
  "stratigraphy.range": McpToolResponses["stratigraphy.get_range"];
  "proof.verify": {
    valid: boolean;
    verifiedAt: string;
    computationTimeMs: number;
    error?: string;
  } | {
    valid: boolean;
    status: "bitcoin_block_attested" | "unverified";
    blockHeight: number | null;
    bitcoinHeaderHash: string | null;
  };
  "payment.get_info": {
    standardInvoiceSats: number;
    perToolSats: Record<string, number>;
    acceptedPaymentMethods: string[];
    invoiceExpirySeconds: number;
    challenge: { httpStatus: number; header: string; fields: string[] };
    activeAuthSchemes: string[];
    x402?: { network: string; scheme: string; asset: string; amount: string; payTo: string };
    macaroonRequirements: { authorizationHeader: string; scope: string; maxRequests: number };
  } | {
    verified: boolean;
    /** Non-transferable claims, not a new bearer credential. */
    settlementToken: {
      scheme: "L402" | "x402";
      paymentHash: string;
      scope: string;
      settledAt: string;
    } | null;
  };
  /** @deprecated Use payment.get_info. */
  "payment.info": McpToolResponses["payment.get_info"];
  "proof.get_status": {
    status: ProofLifecycle;
    verifiedAt: string;
    attestationCount: number;
    meshQuorum: boolean;
  };
  /** @deprecated Use proof.get_status. */
  "proof.status": {
    status: ProofLifecycle;
    verifiedAt: string;
    attestationCount: number;
    meshQuorum: boolean;
  };
  "proof.list": { attestations: ProofAttestation[]; total: number };
  "proof.submit": {
    proofHash: string;
    status: "verified" | "invalid";
    submittedAt: string;
    attestationStatus: string;
  };
  "proof.ground": { receipt: GroundReceipt };
  "mesh.get_status": {
    nodePubkey: string;
    activePeerCount: number;
    configuredPeerCount: number;
    topologyHealth: "healthy" | "degraded" | "isolated";
    crossValidationSuccessRate: number;
    averagePropagationLatencyMs: number;
    quorumThreshold: number;
  };
  /** @deprecated Use mesh.get_status. */
  "mesh.status": {
    nodePubkey: string;
    activePeerCount: number;
    configuredPeerCount: number;
    topologyHealth: "healthy" | "degraded" | "isolated";
    crossValidationSuccessRate: number;
    averagePropagationLatencyMs: number;
    quorumThreshold: number;
  };
  "proof.issue_receipt": {
    receiptHash: string;
    blockTip: number;
    blockHash: string;
    ipfsCid: string;
    nostrEventId?: string;
    attestation: {
      type: "Signed-Bitcoin-Tip-Anchor";
      proofPayload: string;
      verified: boolean;
    };
    timestamp: string;
  };
  /** @deprecated Use proof.issue_receipt. */
  "proof.epistemic_receipt": {
    receiptHash: string;
    blockTip: number;
    blockHash: string;
    ipfsCid: string;
    nostrEventId?: string;
    attestation: {
      type: "Signed-Bitcoin-Tip-Anchor";
      proofPayload: string;
      verified: boolean;
    };
    timestamp: string;
  };
  "mesh.broadcast": {
    signalType: "telemetry_snapshot";
    date: string;
    snapshotDigest: string;
    peerAttestations: number;
    quorumThreshold: number;
    merkleRoot: string;
    networkId: string;
  };
};

export type McpToolName = keyof McpToolArguments;
export type McpListedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

type Challenge = { macaroon: string; invoice: string; payment_hash: string };
type RpcResponse<T> = {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

export class BitcoinStratigraphyClient {
  private nextId = 0;
  protected readonly serverUrl: string;

  constructor(
    serverUrl: string = DEFAULT_MCP_SERVER_URL,
    protected readonly wallet?: WalletHandler,
    protected readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    const url = new URL(serverUrl);
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new Error("MCP server URL must use HTTP or HTTPS");
    }
    this.serverUrl = url.toString();
  }

  async listTools(): Promise<McpListedTool[]> {
    const result = await this.request<{ tools: McpListedTool[] }>("tools/list");
    if (!Array.isArray(result.tools)) throw new Error("Invalid MCP tools/list response");
    return result.tools;
  }

  callTool<K extends McpToolName>(
    name: K,
    args: McpToolArguments[K],
  ): Promise<McpToolResponses[K]>;
  /** Call a server-advertised MCP tool even when it is not in this SDK's typed catalog. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  async callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.request<{
      structuredContent?: unknown;
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    }>("tools/call", { name, arguments: args ?? {} });
    if (result.isError) {
      throw new Error(result.content?.find((item) => item.type === "text")?.text ?? `${name} failed`);
    }
    if (!result.structuredContent || typeof result.structuredContent !== "object") {
      throw new Error(`Missing structuredContent from ${name}`);
    }
    return result.structuredContent;
  }

  getTelemetry(args: McpToolArguments["stratigraphy.get"] = {}) {
    return this.callTool("stratigraphy.get", args);
  }
  listStratigraphy() { return this.callTool("stratigraphy.list", {}); }
  getStratigraphyDigest(args: McpToolArguments["stratigraphy.get_digest"] = {}) {
    return this.callTool("stratigraphy.get_digest", args);
  }
  getStratigraphyDiff(args: McpToolArguments["stratigraphy.get_diff"]) {
    return this.callTool("stratigraphy.get_diff", args);
  }
  getStratigraphyRange(args: McpToolArguments["stratigraphy.get_range"]) {
    return this.callTool("stratigraphy.get_range", args);
  }
  verifyProof(args: McpToolArguments["proof.verify"]) {
    return this.callTool("proof.verify", args);
  }
  verifyOtsProof(args: { otsProof: string; targetHash: string }) {
    return this.callTool("proof.verify", { proofType: "ots", ...args });
  }
  getPaymentInfo(args: { toolName?: string } = {}) {
    return this.callTool("payment.get_info", args);
  }
  settlePayment(args: { paymentHash: string; preimage: string; txHash?: never } | { paymentHash: string; txHash: string; preimage?: never }) {
    return this.callTool("payment.get_info", { action: "settle", ...args });
  }
  getProofStatus(args: McpToolArguments["proof.get_status"]) {
    return this.callTool("proof.get_status", args);
  }
  issueEpistemicReceipt(args: McpToolArguments["proof.issue_receipt"]) {
    return this.callTool("proof.issue_receipt", args);
  }
  listProofs(args: McpToolArguments["proof.list"] = {}) {
    return this.callTool("proof.list", args);
  }
  submitProof(args: McpToolArguments["proof.submit"]) {
    return this.callTool("proof.submit", args);
  }
  groundProof(args: McpToolArguments["proof.ground"]) {
    return this.callTool("proof.ground", args);
  }
  getMeshStatus() { return this.callTool("mesh.get_status", {}); }
  broadcastMeshSignal(date: string) {
    return this.callTool("mesh.broadcast", {
      signalType: "telemetry_snapshot",
      payload: { date },
    });
  }

  protected async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.nextId;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const send = (authorization?: string) =>
      this.fetcher(this.serverUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body,
        redirect: "error",
      });

    let response = await send();
    if (response.status === 402) {
      response = await this.retryL402(response, method, send);
    }
    return parseRpcResponse<T>(response, id);
  }

  protected async retryL402(
    response: Response,
    method: string,
    send: (authorization?: string) => Promise<Response>,
  ): Promise<Response> {
    const challenge = await parseChallenge(response);
    if (!this.wallet) throw new Error(`L402 payment required for ${method}; provide a wallet callback`);
    const paid = await this.wallet(challenge.invoice);
    const preimage = typeof paid === "string"
      ? paid
      : "preimage" in paid ? paid.preimage : paid.payment_preimage;
    if (/^[0-9a-fA-F]{64}$/.test(preimage)) {
      const bytes = Uint8Array.from(preimage.match(/.{2}/g)!, (hex) => Number.parseInt(hex, 16));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      if (hash !== challenge.payment_hash.toLowerCase()) {
        throw new Error("Wallet preimage does not match the L402 payment hash");
      }
    } else if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(preimage)) {
      throw new Error("Wallet did not return a 32-byte hex payment preimage or CoinOS payment reference");
    }
    response = await send(`L402 ${challenge.macaroon}:${preimage.toLowerCase()}`);
    if (response.status === 402) throw new Error("L402 payment was rejected; not paying again");
    return response;
  }
}

/**
 * Client supporting the existing L402 flow and x402 v2 Base USDC payments.
 * x402 is opt-in: configure an agent signer and a hard micro-USDC spending cap.
 */
export class StratigraphyClient extends BitcoinStratigraphyClient {
  private nextStratigraphyId = 0;
  private readonly x402Wallet?: X402WalletHandler;
  private readonly maxPaymentMicroUsdc?: bigint;

  constructor(
    serverUrl: string = DEFAULT_MCP_SERVER_URL,
    options: StratigraphyClientOptions = {},
  ) {
    super(serverUrl, options.wallet, options.fetcher);
    this.x402Wallet = options.x402Wallet;
    if (options.maxPaymentMicroUsdc !== undefined) {
      const cap = String(options.maxPaymentMicroUsdc);
      if (!/^\d+$/.test(cap)) throw new Error("maxPaymentMicroUsdc must be a non-negative integer");
      this.maxPaymentMicroUsdc = BigInt(cap);
    }
    if (this.x402Wallet && this.maxPaymentMicroUsdc === undefined) {
      throw new Error("maxPaymentMicroUsdc is required when an x402 wallet is configured");
    }
  }

  protected override async request<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = ++this.nextStratigraphyId;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const send = (paymentSignature?: string) =>
      this.fetcher(this.serverUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
          ...(paymentSignature ? { "PAYMENT-SIGNATURE": paymentSignature } : {}),
        },
        body,
        redirect: "error",
      });

    let response = await send();
    if (response.status === 402) {
      const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
      if (requiredHeader !== null && this.x402Wallet) {
        const terms = parseX402Requirements(requiredHeader, this.serverUrl, this.maxPaymentMicroUsdc);
        const signature = await this.x402Wallet(terms);
        validateX402Signature(signature, terms);
        response = await send(signature);
        if (response.status === 402) throw new Error("x402 payment was rejected; not paying again");
      } else if (this.wallet) {
        response = await this.retryL402(response, method, (authorization) => {
          // Use the standard Authorization header for the backward-compatible L402 retry.
          return this.fetcher(this.serverUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": "2025-03-26",
              ...(authorization ? { Authorization: authorization } : {}),
            },
            body,
            redirect: "error",
          });
        });
      } else {
        throw new Error(
          `Payment required for ${method}; configure an x402 agent signer or L402 wallet callback`,
        );
      }
    }
    return parseRpcResponse<T>(response, id);
  }
}

const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function parseX402Requirements(
  header: string,
  serverUrl: string,
  maxAmount: bigint | undefined,
): X402PaymentTerms {
  let envelope: unknown;
  try {
    envelope = JSON.parse(decodeBase64(header));
  } catch {
    throw new Error("Invalid base64 PAYMENT-REQUIRED x402 envelope");
  }
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Invalid PAYMENT-REQUIRED x402 envelope");
  }
  const value = envelope as {
    x402Version?: unknown;
    accepts?: unknown;
    resource?: Record<string, unknown>;
  };
  if (value.x402Version !== 2 || !Array.isArray(value.accepts)) {
    throw new Error("Unsupported PAYMENT-REQUIRED x402 version or format");
  }
  let resourceUrl: string;
  try {
    if (typeof value.resource?.url !== "string") throw new Error("missing URL");
    resourceUrl = new URL(value.resource.url).toString();
  } catch {
    throw new Error("Invalid x402 resource URL");
  }
  if (resourceUrl !== serverUrl) throw new Error("x402 resource URL does not match the MCP server URL");
  const accepted = value.accepts.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    return item.scheme === "exact" && item.network === "eip155:8453";
  }) as Record<string, unknown> | undefined;
  if (!accepted) throw new Error("x402 challenge does not offer exact payments on eip155:8453");
  if (
    typeof accepted.asset !== "string" ||
    accepted.asset.toLowerCase() !== BASE_USDC_ADDRESS
  ) {
    throw new Error("x402 challenge asset is not USDC on Base");
  }
  if (
    typeof accepted.payTo !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(accepted.payTo) ||
    /^0x0{40}$/i.test(accepted.payTo)
  ) {
    throw new Error("x402 challenge has an invalid or zero payTo address");
  }
  if (typeof accepted.amount !== "string" || !/^\d+$/.test(accepted.amount)) {
    throw new Error("x402 challenge amount must be integer micro-USDC");
  }
  const amount = BigInt(accepted.amount);
  if (amount === 0n) throw new Error("x402 challenge must require a non-zero payment");
  if (maxAmount === undefined || amount > maxAmount) {
    throw new Error("x402 challenge exceeds the configured maximum micro-USDC amount");
  }
  if (
    !Number.isSafeInteger(accepted.maxTimeoutSeconds) ||
    (accepted.maxTimeoutSeconds as number) <= 0
  ) {
    throw new Error("x402 challenge has an invalid maxTimeoutSeconds");
  }
  if (!accepted.extra || typeof accepted.extra !== "object") {
    throw new Error("x402 challenge is missing token payment metadata");
  }
  const extra = accepted.extra as Record<string, unknown>;
  if (extra.paymentFlow !== "upfront" || extra.name !== "USD Coin" || extra.version !== "2") {
    throw new Error("x402 challenge has unsupported USDC payment metadata");
  }
  if (extra.settlementAvailable === false) {
    throw new Error("x402 settlement is unavailable; use L402 instead");
  }
  const resource = value.resource as Record<string, unknown>;
  const acceptedTerms = {
    ...accepted,
    scheme: "exact" as const,
    network: "eip155:8453" as const,
    asset: accepted.asset,
    amount: accepted.amount,
    payTo: accepted.payTo,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds as number,
    extra: extra as X402PaymentRequirements["extra"],
  } as X402PaymentRequirements;
  return {
    x402Version: 2,
    accepted: acceptedTerms,
    resource: { ...resource, url: resourceUrl },
  };
}

function validateX402Signature(signature: string, terms: X402PaymentTerms): void {
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64(signature));
  } catch {
    throw new Error("Agent signer must return a base64 PAYMENT-SIGNATURE x402 payload");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid x402 PAYMENT-SIGNATURE payload");
  }
  const envelope = payload as {
    x402Version?: unknown;
    accepted?: unknown;
    resource?: unknown;
    payload?: {
      signature?: unknown;
      authorization?: { to?: unknown; value?: unknown };
    };
  };
  if (envelope.x402Version !== 2) {
    throw new Error("Agent signer returned a mismatched x402 v2 version");
  }
  if (!jsonValuesEqual(envelope.accepted, terms.accepted)) {
    throw new Error("Agent signer accepted terms do not match the x402 challenge");
  }
  if (
    !envelope.resource ||
    typeof envelope.resource !== "object" ||
    (envelope.resource as Record<string, unknown>).url !== terms.resource.url
  ) {
    throw new Error("Agent signer resource does not match the x402 challenge");
  }
  const payment = envelope.payload;
  if (typeof payment?.signature !== "string" || payment.signature.length === 0) {
    throw new Error("Agent signer returned an x402 payload without a signature");
  }
  const authorization = payment.authorization;
  if (
    !authorization ||
    typeof authorization.to !== "string" ||
    authorization.to.toLowerCase() !== terms.accepted.payTo.toLowerCase() ||
    (typeof authorization.value !== "string" && typeof authorization.value !== "number") ||
    String(authorization.value) !== terms.accepted.amount
  ) {
    throw new Error("Agent signer payment authorization does not match accepted x402 terms");
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return stable(left) === stable(right);
}

function decodeBase64(value: string): string {
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new Error("Invalid base64");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return atob(padded);
}

async function parseRpcResponse<T>(response: Response, id: number): Promise<T> {
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  const envelope = await response.json() as RpcResponse<T>;
  if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
    throw new Error("Invalid MCP JSON-RPC response");
  }
  if (envelope.error) throw new Error(`MCP ${envelope.error.code}: ${envelope.error.message}`);
  if (envelope.result === undefined) throw new Error("MCP response has no result");
  return envelope.result;
}

async function parseChallenge(response: Response): Promise<Challenge> {
  const header = response.headers.get("WWW-Authenticate") ?? "";
  const match = /^L402\s+macaroon="([^"\r\n]+)",\s*invoice="([^"\r\n]+)"$/i.exec(header);
  if (!match) throw new Error("HTTP 402 did not include an L402 WWW-Authenticate challenge");
  const body = await response.json() as Partial<Challenge>;
  if (
    body.macaroon !== match[1] ||
    body.invoice !== match[2] ||
    !body.invoice.startsWith("ln") ||
    !/^[0-9a-fA-F]{64}$/.test(body.payment_hash ?? "")
  ) {
    throw new Error("Invalid or conflicting L402 challenge");
  }
  return body as Challenge;
}