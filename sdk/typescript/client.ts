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
  "proof.verify": {
    proof: string;
    publicInputs: PublicInputs;
    verificationKeyId: string;
    data: Record<string, unknown> | Record<string, unknown>[];
  };
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
  "proof.verify": {
    valid: boolean;
    verifiedAt: string;
    computationTimeMs: number;
    error?: string;
  };
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
  private readonly serverUrl: string;

  constructor(
    serverUrl: string = DEFAULT_MCP_SERVER_URL,
    private readonly wallet?: WalletHandler,
    private readonly fetcher: typeof fetch = globalThis.fetch,
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

  async callTool<K extends McpToolName>(
    name: K,
    args: McpToolArguments[K],
  ): Promise<McpToolResponses[K]> {
    const result = await this.request<{
      structuredContent?: McpToolResponses[K];
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    }>("tools/call", { name, arguments: args });
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
  verifyProof(args: McpToolArguments["proof.verify"]) {
    return this.callTool("proof.verify", args);
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

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
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
    }
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
    const envelope = await response.json() as RpcResponse<T>;
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
      throw new Error("Invalid MCP JSON-RPC response");
    }
    if (envelope.error) throw new Error(`MCP ${envelope.error.code}: ${envelope.error.message}`);
    if (envelope.result === undefined) throw new Error("MCP response has no result");
    return envelope.result;
  }
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