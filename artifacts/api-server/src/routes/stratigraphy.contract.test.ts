import assert from "node:assert/strict";
import { QuoteMcpToolCostsResponse, type McpBatchCostQuote } from "@workspace/api-zod";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerPublicCors } from "../middleware/publicCors";
import { parse } from "yaml";
import { openApiDocument } from "../openapi";
import healthRouter from "./health";
import { registerMcpRequestGuard, registerMcpRoute } from "./mcp";
import { verifyEpistemicDatasetReceipt } from "../services/epistemicDatasetReceipt";
import type { SettlementRouter } from "../services/settlement";
import {
  glamaConnector,
  mcpServerCard,
  registerMcpServerCardRoute,
} from "./mcp-server-card";
import { ENGINE_DESCRIPTION, MCP_TOOL_GROUPS } from "../lib/engine-metadata";
import { mcpDiscoveryManifest } from "../lib/mcp-discovery-manifest";
import { registerOpenApiRoute } from "./openapi";
import { readDataset, registerStratigraphyRoutes } from "./stratigraphy";
import { registerLlmExportRoutes } from "./llm-export";
import { MeshGossipService, canonicalMeshJson } from "../services/meshGossipService";
import { NostrWebOfTrust } from "../services/nostrWebOfTrust";
import { createNostrAttestor } from "../services/nostrAttestation";
import { createMemoryPaymentChallengeStore } from "../lib/payment-challenge-store";
import type { PaymentChallengeStore } from "../lib/payment-challenge-store";
import { createPostgresPaymentChallengeStore } from "../lib/postgres-payment-challenge-store";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  verifySubscriptionMacaroon,
  getMacaroonSignatureId,
} from "../lib/subscription-pass";
import { pool } from "@workspace/db";
import { buildHeartbeatEvent } from "../lib/nostr-heartbeat";
import { registerNostrStatusRoute } from "./nostr-status";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  verifyEvent,
} from "nostr-tools";
import { createMemoryMacaroonRevocationStore } from "../lib/macaroon-revocation-store";
import { createPostgresMacaroonRevocationStore } from "../lib/postgres-macaroon-revocation-store";
import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  calculateTierCost,
  createPricingEngine,
} from "../services/pricing";
import { createAgentReputationService } from "../services/agentReputation";
import { createMemoryRevenueLedger } from "../services/ledger";
import {
  createHttpRateLimitMiddleware,
  createSlidingWindowRateLimiter,
} from "../middleware/rateLimiter";

const preimage = "11".repeat(32);
const paymentHash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");
const invoice = "lnbc210n1contracttest";
const operatorSecret = "contract-test-operator-secret";
const vipAgentKey = generateSecretKey();
const vipAgentPubkey = getPublicKey(vipAgentKey);
const otherAgentKey = generateSecretKey();
process.env.MACAROON_OPERATOR_SECRET = operatorSecret;
const fullDatasetAmountMsats = 422_000;
const fullDatasetDescription =
  "Bitcoin Stratigraphy days 1-422 (422 days) access";
const expectedMcpOverview = ENGINE_DESCRIPTION;
const expectedMcpToolDescriptions: Record<string, string> = {
  "proof.get_by_hash":
    "Retrieve one retained proof payload, signed receipt, or lifecycle-only status using exactly one known `hash` (proof or receipt hash, CID, snapshot digest, or submission UUID) or `jobId` (submission UUID). Looks up bounded process-local records without re-running Groth16 proof verification; receipt provenance may be checked against the current dataset, and missing payloads cannot be reconstructed. Use `proof.list` to discover indexed proof hashes and `proof.verify` to cryptographically verify supplied proof inputs.",
  "proof.list":
    "Discover, filter, and paginate recent zk-proof attestation lifecycle summaries from bounded process-local memory. Use `limit` (1-100, default 20), zero-based `offset` (0-1000, default 0), and optional `status` (`verified`, `cached`, `pending`, or `invalid`); cursor pagination is not supported. Returns newest-first bounded summaries, not full proof payloads or receipts. Use `proof.get_by_hash` for an individual retained proof or receipt by known ID. Read-only; costs 10 sats via HTTP L402 without valid credentials.",
  "payment.get_info":
    "Query MCP pricing parameters (`action='query'`, the default) or verify authenticated settlement (`action='settle'` with a payment hash and either an L402 preimage or Base transaction hash). Use `query` for price discovery before calling paid tools; use `settle` to check payment status, not to issue an invoice. Macaroons and Lightning invoices are issued dynamically via HTTP 402 challenges with bounded expiration; operator-only admin operations are intentionally omitted.",
  "stratigraphy.list":
    "Discover indexed height and UTC date bounds, available metrics, and catalog metadata. Free, parameterless, read-only discovery entry point for selecting valid strata. Once bounds are known, use `stratigraphy.get` for full record bodies, `stratigraphy.get_range` for compact contiguous spans, or `stratigraphy.get_digest` for lightweight source-record fingerprints.",
  "stratigraphy.get_range":
    "Retrieve a contiguous span of compressed indexed stratum summaries across inclusive height or UTC date bounds. Read-only, HTTP rate-limited and L402-paid; startTarget is required, endTarget defaults to the latest indexed entry, and limit caps the returned batch at 1-100 records (default 50) without changing the requested bounds. Primary tool for compact multi-record spans; use `stratigraphy.get` for full telemetry record bodies, `stratigraphy.get_digest` for source-record fingerprints, and `stratigraphy.get_diff` for parameter deltas between two entries.",
  "proof.attenuate":
    "Attenuate an authentic, unexpired L402 parent `macaroon` by appending supported restrictive `caveats` (tool, target, expiration, path, or request-count limits) and optionally `ttlSeconds`. The `caveats` array is required but may be empty when `ttlSeconds` is supplied; at least one restriction is required. Appended caveats can only narrow inherited permissions, never widen token authority. Free to call; returns a restricted child macaroon without issuing an invoice, and the parent's payment proof is still required for later redemption. Invalid parents or unsupported caveats return an error.",
  "stratigraphy.get_diff":
    "Compute signed numerical deltas (indexed height, target multiplier, percentage change, and elapsed days calculated from toTarget minus fromTarget) between two indexed stratum heights or dates. Read-only, stateless operation subject to HTTP rate limiting and L402 payment; missing stratum entries yield JSON-RPC invalid-params errors. Requires valid `fromTarget` baseline; `toTarget` defaults to `latest`. Use this tool specifically to compare two point-in-time entries. Use `stratigraphy.get` for full stratum record lookups, `stratigraphy.get_range` for continuous compact multi-record spans, and `stratigraphy.get_digest` for indexed source-record fingerprints; stratigraphy data ingest is outside this comparison tool.",
  "stratigraphy.get_digest":
    "Fetch compact source-record fingerprints and metadata for an indexed stratum height, date, or bounded date range. Returns no full record telemetry or Bitcoin block-header hash; the fingerprint is not a verification receipt. Use this tool instead of `stratigraphy.get` when a compact fingerprint is enough; use `stratigraphy.get_range` for contiguous multi-record summaries and `stratigraphy.list` for catalog discovery.",
  "proof.ground":
    "PURPOSE & BOUNDARIES: Issue a signed Bitcoin-tip receipt for either agent context (contextHash plus agentId) or a dataset CID; this is an anchor, not a ZK or Bitcoin-confirmed OTS proof. USAGE GUIDELINES: Use `proof.verify` for proof verification without anchoring or `proof.get_by_hash` for existing receipts. BEHAVIOR & CONSEQUENCES: Creates a receipt and costs 250 sats via HTTP L402 without valid credentials; the two input modes are exclusive, invalid inputs fail, and tip/provider availability is required.",
  "proof.verify":
    "Execute cryptographic verification for supplied Groth16 telemetry or drift zk-SNARK proofs, or OpenTimestamps receipts. Returns proof validity; verification can update a bounded in-memory lifecycle index, and drift checks require a Bitcoin block provider. Use this tool to verify supplied proofs; use `proof.submit` to register new Groth16 proofs and `proof.get_by_hash` to retrieve retained proofs or signed receipts by a known identifier.",
  "proof.submit":
    "PURPOSE & BOUNDARIES: Submit and register a new Groth16 zk-SNARK proof with its five public signals, then attempt a Nostr NIP-78 attestation; this changes proof registry state, but does not append a proof to a Merkle tree. USAGE GUIDELINES: Use `proof.submit` strictly for registering new attestations, and use `proof.verify` instead when validating an existing proof without state mutation. Use `proof.get_by_hash` for retained submissions or `proof.ground` for a Bitcoin-tip receipt. BEHAVIOR & CONSEQUENCES: Costs 250 sats via HTTP L402 without valid credentials; malformed inputs fail validation, invalid proofs are reported, and Nostr publication status may fail separately.",
  "mesh.broadcast":
    "PURPOSE & BOUNDARIES: Sign a stored daily telemetry snapshot selected by date and distribute it to pinned mesh peers for cross-validation; arbitrary payloads or inbound peer sync publication are not supported. USAGE GUIDELINES: Use this instead of `mesh.get_status` only when sending a snapshot for peer acknowledgment. BEHAVIOR & CONSEQUENCES: Side-effecting and costs 250 sats via HTTP L402 without valid credentials; missing records, invalid agent events, unavailable peers, or failed quorum return errors.",
  "stratigraphy.get":
    "Retrieve indexed telemetry record bodies by indexed height or UTC ISO date, or query recent days and bounded date/height ranges. Returns full record fields by default; optional metrics project selected telemetry fields, and limit caps results at 1-100 (default 10). Read-only, HTTP rate-limited and L402-paid. Use `date` or `blockHeight` for single-entry deep inspection; use `stratigraphy.get_range` for compact contiguous multi-record spans, `stratigraphy.get_digest` for lightweight source-record fingerprints, `stratigraphy.get_diff` for point-in-time deltas, and `stratigraphy.list` to discover indexed bounds.",
  "mesh.get_status":
    "Inspect P2P peer counts, topology health, cross-validation rate, propagation latency, and quorum. Free, read-only status; use `mesh.broadcast` to distribute a snapshot. Note: Mesh consensus is automated; this tool does not administer peers or edit topology. No internal peer-administration HTTP tool is advertised.",
};

type OpenApiDocument = {
  paths: Record<string, { get?: unknown }>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
};

function paymentContract(document: OpenApiDocument) {
  const readiness = document.paths["/readyz"]?.get as {
    security?: unknown;
    responses?: unknown;
  };
  const sample = document.paths["/v1/stratigraphy/sample"]?.get as {
    responses?: unknown;
  };
  const paid = document.paths["/v1/stratigraphy"]?.get as {
    security?: unknown;
    responses?: unknown;
  };

  return {
    readiness: {
      security: readiness?.security,
      responses: readiness?.responses,
    },
    sample: { responses: sample?.responses },
    paid: {
      security: paid?.security,
      responses: paid?.responses,
    },
    securityScheme: document.components.securitySchemes.L402,
    challengeSchema: document.components.schemas.L402Challenge,
    rateLimitSchema:
      document.components.schemas.PaymentChallengeRateLimitError,
    configurationErrorSchema:
      document.components.schemas.PaymentConfigurationError,
    challengeServiceUnavailableSchema:
      document.components.schemas.PaymentChallengeServiceUnavailableError,
    walletGatewaySchema: document.components.schemas.WalletGatewayError,
    entrySchema: document.components.schemas.StratigraphyEntry,
    readinessSchema: document.components.schemas.ReadinessStatus,
  };
}

function mcpSchemaContract(schema: unknown, path: string): unknown {
  assert.ok(
    typeof schema === "object" && schema !== null && !Array.isArray(schema),
    `${path} must be a JSON Schema object`,
  );
  const input = schema as Record<string, unknown>;
  const contract: Record<string, unknown> = {};
  for (const key of [
    "type",
    "additionalProperties",
    "required",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]) {
    if (Object.hasOwn(input, key)) {
      if (key === "required" && Array.isArray(input[key])) {
        if (input[key].length > 0) {
          contract[key] = [...(input[key] as unknown[])].sort();
        }
      } else if (
        key === "additionalProperties" &&
        typeof input[key] === "object" &&
        input[key] !== null &&
        !Array.isArray(input[key])
      ) {
        contract[key] = mcpSchemaContract(
          input[key],
          `${path}.additionalProperties`,
        );
      } else {
        contract[key] = input[key];
      }
    }
  }
  if (Object.hasOwn(input, "properties")) {
    const properties = input.properties;
    assert.ok(
      typeof properties === "object" && properties !== null &&
        !Array.isArray(properties),
      `${path}.properties must be an object`,
    );
    contract.properties = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, propertySchema]) => [
          name,
          mcpSchemaContract(propertySchema, `${path}.properties.${name}`),
        ]),
    );
  }
  if (Object.hasOwn(input, "items")) {
    contract.items = mcpSchemaContract(input.items, `${path}.items`);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Object.hasOwn(input, key)) {
      const branches = input[key];
      assert.ok(Array.isArray(branches), `${path}.${key} must be an array`);
      contract[key] = branches
        .map((branch, index) =>
          mcpSchemaContract(branch, `${path}.${key}[${index}]`),
        )
        .sort((left, right) =>
          (JSON.stringify(left) ?? "").localeCompare(
            JSON.stringify(right) ?? "",
          ),
        );
    }
  }
  return contract;
}

type Transaction = {
  type: "incoming" | "outgoing";
  state: "settled" | "pending" | "failed";
  amount: number;
  description: string;
  payment_hash: string;
  preimage?: string;
  invoice: string;
  settled_at: number;
};

async function withContractServer(
  clientFactory: Parameters<typeof registerStratigraphyRoutes>[1],
  run: (paidUrl: string, baseUrl: string) => Promise<void>,
  meshService?: MeshGossipService,
) {
  const contractApp = express();
  contractApp.use(express.json());
  contractApp.use((req, _res, next) => {
    (req as any).log = {
      error: () => undefined,
    };
    next();
  });
  registerOpenApiRoute(contractApp);
  registerStratigraphyRoutes(
    contractApp,
    clientFactory,
    undefined,
    createMemoryPaymentChallengeStore(),
    undefined, undefined, undefined, undefined,
    { meshService },
  );
  const contractServer = contractApp.listen(0);
  await new Promise<void>((resolve) =>
    contractServer.once("listening", resolve),
  );
  const address = contractServer.address() as AddressInfo;

  try {
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await run(`${baseUrl}/api/v1/stratigraphy`, baseUrl);
  } finally {
    contractServer.close();
  }
}

test("verifies public Nostr identity and binds a trusted agent session to mesh.attest", async () => {
  const originKey = generateSecretKey();
  const originPubkey = getPublicKey(originKey);
  const originSecret = Buffer.from(originKey).toString("hex");
  const nodeKey = generateSecretKey();
  const identityService = new NostrWebOfTrust({
    trustedPubkeys: [originPubkey],
    networkId: "bitcoin-stratigraphy-mainnet-v1",
    loadEvents: async () => [],
  });
  const mesh = new MeshGossipService({
    privateKey: Buffer.from(nodeKey).toString("hex"),
    peers: [{ url: "https://origin.example", pubkey: originPubkey }],
    identityService,
  });
  await withContractServer(undefined, async (_paidUrl, base) => {
    const identity = await fetch(`${base}/api/nostr/verify-identity`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: nip19.npubEncode(originPubkey) }),
    });
    assert.equal(identity.status, 200);
    const bareKey = await identity.json() as { pubkey: string; isValidSignature: boolean; trustScore: number };
    assert.equal(bareKey.pubkey, originPubkey);
    assert.equal(bareKey.isValidSignature, false);
    assert.equal(bareKey.trustScore, 1);
    const signatureOnly = await fetch(`${base}/api/nostr/verify-identity`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: "ab".repeat(64) }),
    });
    assert.equal(signatureOnly.status, 400);
    const snapshot = createNostrAttestor(originSecret)({ height: 920_000 });
    const snapshotDigest = createHash("sha256").update(canonicalMeshJson(snapshot)).digest("hex");
    const event = finalizeEvent({
      kind: 20079, created_at: Math.floor(Date.now() / 1_000), tags: [],
      content: JSON.stringify({ networkId: mesh.networkId, snapshotDigest }),
    }, originKey);
    const verified = await fetch(`${base}/api/nostr/verify-identity`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, signature: event.sig }),
    });
    assert.equal(verified.status, 200);
    const body = await verified.json() as { pubkey: string; isValidSignature: boolean; trustScore: number; firstSeenTimestamp: number };
    assert.equal(body.pubkey, originPubkey);
    assert.equal(body.isValidSignature, true);
    assert.equal(body.trustScore, 1);
    assert.equal(body.firstSeenTimestamp, event.created_at);
    const request = { snapshot, snapshotDigest, networkId: mesh.networkId,
      originPubkey, agentSession: { event } };
    const attest = async (value: unknown) => fetch(`${base}/api/v1/mesh/attest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    const rejected = await attest({ ...request, agentSession: {
      event: { ...event, content: JSON.stringify({ networkId: mesh.networkId, snapshotDigest: "ff".repeat(32) }) },
    } });
    assert.equal(rejected.status, 422);
    assert.equal(mesh.getSessionState(snapshotDigest), undefined);
    const accepted = await attest(request);
    assert.equal(accepted.status, 200);
    assert.equal(mesh.getSessionState(snapshotDigest)?.pubkey, originPubkey);
    const response = await accepted.json() as {
      event: Parameters<typeof verifyEvent>[0];
      agentIdentity: { pubkey: string; isValidSignature: boolean; trustScore: number };
    };
    assert.equal(verifyEvent(response.event), true);
    assert.equal(response.agentIdentity.pubkey, originPubkey);
    assert.equal(response.agentIdentity.isValidSignature, true);
    assert.equal(response.agentIdentity.trustScore, 1);
  }, mesh);
});

const validTransaction: Transaction = {
  type: "incoming",
  state: "settled",
  amount: fullDatasetAmountMsats,
  description: fullDatasetDescription,
  payment_hash: paymentHash,
  preimage,
  invoice,
  settled_at: Math.floor(Date.now() / 1000),
};

let transaction = validTransaction;
let invoiceRequest: Record<string, unknown> | undefined;
let invoiceRequestCount = 0;
let invoiceGate: Promise<void> | undefined;
let lookupInvoiceCount = 0;
const app = express();
app.set("trust proxy", 1);
const staticPricingEngine = {
  recordRequest: () => undefined,
  requestVelocity: () => 0,
  quote: (tier: "1-day" | "30-day") => calculateTierCost(tier),
};
const groundingLedger = createMemoryRevenueLedger();
const mcpInvoices = new Map<string, {
  preimage: string;
  amountMsats: number;
  description: string;
}>();
let mcpInvoiceCount = 0;
const mcpSettlementRouter: SettlementRouter = {
  isConfigured: () => true,
  activeProvider: () => "contract-mcp",
  circuitState: () => "closed",
  createInvoice: async (input) => {
    const invoicePreimage = (mcpInvoiceCount++).toString(16).padStart(64, "0");
    const hash = createHash("sha256").update(Buffer.from(invoicePreimage, "hex")).digest("hex");
    mcpInvoices.set(hash, {
      preimage: invoicePreimage,
      amountMsats: input.amountMsats,
      description: input.description,
    });
    return { invoice: `lnbc${input.amountMsats}contractmcp`, paymentHash: hash, provider: "contract-mcp" };
  },
  verifyPayment: async (input) => {
    const issued = mcpInvoices.get(input.paymentHash);
    return issued &&
      issued.preimage === input.preimage &&
      issued.amountMsats === input.expectedAmountMsats &&
      issued.description === input.expectedDescription &&
      input.expectedProvider === "contract-mcp" &&
      input.asset === "btc-lightning"
      ? { settledAt: Date.now(), provider: "contract-mcp" }
      : "invalid";
  },
};

function agentAuthorization(
  key: Uint8Array,
  url: string,
  method = "GET",
  payload?: string,
) {
  const event = finalizeEvent(
    {
      kind: 27_235,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["u", url],
        ["method", method],
        ...(payload === undefined
          ? []
          : [
              [
                "payload",
                createHash("sha256").update(payload).digest("hex"),
              ],
            ]),
      ],
      content: "",
    },
    key,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
registerPublicCors(app);
registerMcpRequestGuard(app);
app.use(
  express.json({
    verify(req, _res, buffer) {
      (req as express.Request & { rawBody?: Buffer }).rawBody =
        Buffer.from(buffer);
    },
  }),
);
registerOpenApiRoute(app);
registerMcpServerCardRoute(app);
registerMcpRoute(app, {
  settlementRouter: mcpSettlementRouter,
  sessionSecret: "contract-mcp-secret",
  readBitcoinTip: async () => ({
    height: 920001,
    hash: "ab".repeat(32),
    source: "contract-test",
  }),
});
registerNostrStatusRoute(app);
registerLlmExportRoutes(app);
app.use("/api", healthRouter);
registerStratigraphyRoutes(app, () => ({
  lookupInvoice: async () => {
    lookupInvoiceCount += 1;
    return transaction as never;
  },
  makeInvoice: async (request) => {
    invoiceRequest = request;
    invoiceRequestCount += 1;
    await invoiceGate;
    return transaction as never;
  },
  close: () => undefined,
}), {
  now: Date.now,
  reuseMs: 5 * 60 * 1000,
  limitWindowMs: 60 * 60 * 1000,
  maxInvoicesPerWindow: 100,
  maxCallers: 10_000,
},
createMemoryPaymentChallengeStore(),
undefined,
undefined,
staticPricingEngine,
undefined,
{
  agentReputation: createAgentReputationService({
    tiers: { [vipAgentPubkey]: "VIP" },
  }),
  revenueLedger: groundingLedger,
  readBitcoinTip: async () => ({
    height: 920001,
    hash: "ab".repeat(32),
    source: "contract-test",
  }),
});

let baseUrl: string;
const server = app.listen(0);

before(async () => {
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

async function mcpRequest(method: string, params?: Record<string, unknown>, targetBaseUrl = baseUrl) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(params ? { params } : {}),
  });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-03-26",
  };
  let response = await fetch(`${targetBaseUrl}/mcp`, {
    method: "POST",
    headers,
    body: payload,
  });
  if (response.status === 402) {
    const challenge = await response.json() as {
      macaroon: string;
      payment_hash: string;
      amount_sats: number;
      invoice: string;
    };
    const expected = [
      "proof.list",
      "proof.status",
    ].includes(String(params?.name))
      ? 10 : 250;
    assert.equal(challenge.amount_sats, expected);
    assert.match(response.headers.get("www-authenticate") ?? "", /L402 macaroon=".+", invoice="ln.+"/);
    assert.ok(challenge.invoice.startsWith("ln"));
    const payment = mcpInvoices.get(challenge.payment_hash);
    assert.ok(payment);
    response = await fetch(`${targetBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        Authorization: `L402 ${challenge.macaroon}:${payment.preimage}`,
      },
      body: payload,
    });
  }
  assert.equal(response.status, 200);
  return (await response.json()) as {
    result?: Record<string, any>;
    error?: { message: string };
  };
}

async function mcpRequestAt(
  targetBaseUrl: string,
  method: string,
  params?: Record<string, unknown>,
  forwardedFor?: string,
  authorization?: string,
  paymentSignature?: string,
) {
  const response = await fetch(`${targetBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
      ...(paymentSignature ? { "PAYMENT-SIGNATURE": paymentSignature } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
  const body = await response.json() as {
    result?: Record<string, any>;
    error?: { code: number; message: string };
    code?: string;
    retry_after?: number;
  };
  return { response, body };
}

test("retrieves indexed proof payloads and receipts, and reports MCP prices without an invoice", async () => {
  const isolatedApp = express();
  isolatedApp.use(express.json());
  registerMcpRoute(isolatedApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-secret",
    revocationStore: createMemoryMacaroonRevocationStore(),
    readBitcoinTip: async () => ({
      height: 920001, hash: "ab".repeat(32), source: "contract-test",
    }),
  });
  const isolatedServer = isolatedApp.listen(0);
  try {
    await new Promise<void>((resolve) => {
      if (isolatedServer.listening) resolve();
      else isolatedServer.once("listening", resolve);
    });
    const address = isolatedServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    const listed = await mcpRequestAt(url, "tools/list");
    const listedTools = listed.body.result?.tools as Array<{
      name: string;
      inputSchema: { oneOf?: Array<Record<string, any>> };
    }>;
    assert.equal(listedTools.length, 14);
    const paymentTool = listedTools.find(({ name }) => name === "payment.get_info");
    assert.ok(paymentTool);
    assert.equal(paymentTool.inputSchema.oneOf?.length, 2);
    assert.deepEqual(paymentTool.inputSchema.oneOf?.[1].required, ["action", "paymentHash"]);
    assert.equal(paymentTool.inputSchema.oneOf?.[1].oneOf?.length, 2);
    const verifyTool = listedTools.find(({ name }) => name === "proof.verify");
    assert.ok(verifyTool);
    assert.equal(verifyTool.inputSchema.oneOf?.length, 3);
    assert.deepEqual(verifyTool.inputSchema.oneOf?.map((branch) => branch.required), [
      ["proof", "publicInputs", "verificationKeyId", "data"],
      ["circuit", "sessionContextHash", "targetBlockHeight", "entropyThreshold", "proof"],
      ["proofType", "otsProof", "targetHash"],
    ]);
    assert.equal(verifyTool.inputSchema.oneOf?.every(
      (branch) => branch.additionalProperties === false,
    ), true);
    const compactTargetSchema = verifyTool.inputSchema.oneOf?.[1].properties?.compactTarget;
    assert.deepEqual(
      compactTargetSchema && {
        type: compactTargetSchema.type,
        minimum: compactTargetSchema.minimum,
        maximum: compactTargetSchema.maximum,
      },
      { type: "integer", minimum: 0, maximum: 0xffff_ffff },
    );

    const absent = await mcpRequestAt(url, "tools/call", {
      name: "proof.get_by_hash", arguments: { hash: "ef".repeat(32) },
    });
    assert.equal(absent.response.status, 404);
    assert.equal(absent.response.headers.get("www-authenticate"), null);
    assert.equal(absent.body.error?.code, -32004);
    assert.match(absent.body.error?.message ?? "", /not found/i);

    const { response: priceResponse } = await mcpRequestAt(url, "tools/call", {
      name: "payment.info", arguments: {},
    });
    assert.equal(priceResponse.status, 200);
    assert.equal(priceResponse.headers.get("www-authenticate"), null);
    const catalog = await mcpRequestAt(url, "tools/call", {
      name: "stratigraphy.list", arguments: {},
    });
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.response.headers.get("www-authenticate"), null);
    assert.equal(catalog.response.headers.get("payment-required"), null);
    assert.equal(catalog.body.result?.structuredContent.totalSnapshots, 422);
    const paymentInfo = await mcpRequest("tools/call", {
      name: "payment.get_info", arguments: {},
    }, url);
    const prices = paymentInfo.result?.structuredContent.perToolSats;
    assert.equal(Object.keys(prices).length, 14);
    assert.equal(prices["proof.verify"], 250);
    assert.equal(prices["payment.get_info"], 0);
    assert.equal(Object.hasOwn(prices, "payment.info"), false);
    for (const [name, legacyName] of [
      ["stratigraphy.get_digest", "stratigraphy.digest"],
      ["stratigraphy.get_diff", "stratigraphy.diff"],
      ["stratigraphy.get_range", "stratigraphy.range"],
    ]) {
      assert.equal(prices[name], 250);
      assert.equal(Object.hasOwn(prices, legacyName), false);
    }
    assert.equal(Object.hasOwn(prices, "proof.verify_ots"), false);
    assert.equal(Object.hasOwn(prices, "payment.settle"), false);
    const bareSettlement = await mcpRequest("tools/call", {
      name: "payment.info", arguments: { action: "settle", paymentHash, preimage },
    }, url);
    assert.deepEqual(bareSettlement.result?.structuredContent, {
      verified: false, settlementToken: null,
    });
    const canonicalBareSettlement = await mcpRequest("tools/call", {
      name: "payment.get_info", arguments: { action: "settle", paymentHash, preimage },
    }, url);
    assert.deepEqual(canonicalBareSettlement.result?.structuredContent, {
      verified: false, settlementToken: null,
    });
    const unchargedOts = await mcpRequestAt(url, "tools/call", {
      name: "proof.verify",
      arguments: { proofType: "ots", otsProof: "AQID", targetHash: "ab".repeat(32) },
    });
    assert.equal(unchargedOts.response.status, 402);
    const originalPayment = await mcpRequestAt(url, "tools/call", {
      name: "stratigraphy.get", arguments: { days: 1 },
    });
    assert.equal(originalPayment.response.status, 402);
    const offer = originalPayment.body as unknown as {
      macaroon: string; payment_hash: string;
    };
    const invoiceProof = mcpInvoices.get(offer.payment_hash);
    assert.ok(invoiceProof);
    const confirmed = await mcpRequestAt(url, "tools/call", {
      name: "payment.info", arguments: {
        action: "settle", paymentHash: offer.payment_hash, preimage: invoiceProof.preimage,
      },
    }, undefined, `L402 ${offer.macaroon}:${invoiceProof.preimage}`);
    assert.equal(confirmed.response.status, 200);
    assert.deepEqual(confirmed.body.result?.structuredContent.verified, true);
    assert.deepEqual(confirmed.body.result?.structuredContent.settlementToken.scope, "/mcp/tools/stratigraphy.get");
    const mismatched = await mcpRequestAt(url, "tools/call", {
      name: "payment.info", arguments: {
        action: "settle", paymentHash: "dd".repeat(32), preimage: invoiceProof.preimage,
      },
    }, undefined, `L402 ${offer.macaroon}:${invoiceProof.preimage}`);
    assert.deepEqual(mismatched.body.result?.structuredContent, { verified: false, settlementToken: null });
    assert.equal(paymentInfo.result?.structuredContent.standardInvoiceSats, 250);
    assert.equal(prices["proof.get_by_hash"], 250);
    assert.equal(Object.hasOwn(prices, "proof.get_status"), false);
    assert.equal(Object.hasOwn(prices, "proof.issue_receipt"), false);
    assert.equal(prices["payment.get_info"], 0);
    assert.equal(prices["stratigraphy.list"], 0);
    assert.equal(prices["proof.list"], 10);
    assert.equal(prices["mesh.get_status"], 0);
    assert.equal(paymentInfo.result?.structuredContent.invoiceExpirySeconds, 3600);
    assert.deepEqual(paymentInfo.result?.structuredContent.activeAuthSchemes, ["L402"]);
    const onePrice = await mcpRequest("tools/call", {
      name: "payment.info", arguments: { toolName: "proof.get_by_hash" },
    }, url);
    assert.deepEqual(onePrice.result?.structuredContent.perToolSats, { "proof.get_by_hash": 250 });
    const unknownPrice = await mcpRequest("tools/call", {
      name: "payment.info", arguments: { toolName: "proof.unknown" },
    }, url);
    assert.equal(unknownPrice.error?.message.includes("Unknown MCP tool"), true);

    const cid = "Qm" + "a".repeat(44);
    const issued = await mcpRequest("tools/call", {
      name: "proof.ground", arguments: { cid, context: { purpose: "lookup-test" } },
    }, url);
    const receipt = issued.result?.structuredContent.receipt;
    const signedReceipt = JSON.parse(receipt.attestation.proofPayload);
    assert.equal(receipt.ipfsCid, cid);
    assert.equal(signedReceipt.payload.metadata.cid, cid);
    assert.equal(verifyEpistemicDatasetReceipt(receipt), true);
    for (const hash of [receipt.receiptHash, cid]) {
      const found = await mcpRequest("tools/call", {
        name: "proof.get_by_hash", arguments: { hash },
      }, url);
      assert.equal(found.result?.structuredContent.kind, "dataset-receipt");
      assert.equal(found.result?.structuredContent.hash, receipt.receiptHash);
      assert.equal(found.result?.structuredContent.status, "verified");
      assert.equal(found.result?.structuredContent.timestamp, receipt.timestamp);
      assert.deepEqual(found.result?.structuredContent.proofPayload, receipt);
    }

    const data = [{
      block: { height: 920000 },
      observed_at: "2026-09-19T00:00:00.000Z",
      thermodynamic: { target_multiplier: 125.83 },
    }];
    const proof = "invalid-proof-for-lookup";
    const verified = await mcpRequest("tools/call", {
      name: "proof.verify",
      arguments: {
        proof,
        publicInputs: {
          blockHeight: 920000, snapshotDigest: "123456789012345678901234567890", thermodynamicHash: "1",
          timestamp: 1789776000000, valuationSat: 12583,
        },
        verificationKeyId: "sha256:unknown",
        data,
      },
    }, url);
    assert.equal(verified.result?.structuredContent.valid, false);
    const proofHash = `0x${createHash("sha256").update(proof).digest("hex")}`;
    const foundProof = await mcpRequest("tools/call", {
      name: "proof.get_by_hash", arguments: { hash: proofHash.slice(2).toUpperCase() },
    }, url);
    assert.equal(foundProof.result?.structuredContent.kind, "zk-proof");
    assert.equal(foundProof.result?.structuredContent.hash, proofHash);
    assert.equal(foundProof.result?.structuredContent.status, "invalid");
    assert.equal(foundProof.result?.structuredContent.proofPayload.proof, proof);
    assert.deepEqual(foundProof.result?.structuredContent.proofPayload.data, data);

    const driftProof = {
      circuit: "zk.drift.v1",
      sessionContextHash: "ab".repeat(32),
      targetBlockHeight: 920000,
      entropyThreshold: 0.75,
      proof: {
        circuit: "zk.drift.v1",
        pi_a: ["1", "2", "1"],
        pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
        pi_c: ["1", "2", "1"],
        publicSignals: ["1", "2"],
        verificationKeyId: "sha256:4c095e183ea45a9d",
      },
    };
    const mixedProofModes = await mcpRequestAt(url, "tools/call", {
      name: "proof.verify",
      arguments: {
        ...driftProof,
        proof: "legacy proof",
        publicInputs: {
          blockHeight: 920000, snapshotDigest: "1", thermodynamicHash: "1",
          timestamp: 1789776000000, valuationSat: 12583,
        },
        verificationKeyId: "sha256:unknown",
        data,
      },
    });
    assert.equal(mixedProofModes.body.error?.code, -32602);

    const invalidDriftProof = await mcpRequestAt(url, "tools/call", {
      name: "proof.verify",
      arguments: {
        ...driftProof,
        proof: { ...driftProof.proof, circuit: "zk.other.v1" },
      },
    });
    assert.equal(invalidDriftProof.body.error?.code, -32602);

    const stringCompactTarget = await mcpRequestAt(url, "tools/call", {
      name: "proof.verify",
      arguments: { ...driftProof, compactTarget: "1d00ffff" },
    });
    assert.equal(stringCompactTarget.body.error?.code, -32602);

    const driftChallenge = await mcpRequestAt(url, "tools/call", {
      name: "proof.verify",
      arguments: {
        ...driftProof,
        driftScore: 0.25,
        isAligned: true,
        thermodynamicEntropyBits: 0.5,
        blockHash: "ab".repeat(32),
        compactTarget: 486604799,
      },
    });
    assert.equal(driftChallenge.response.status, 402);
    assert.equal((driftChallenge.body as any).amount_sats, 250);
  } finally {
    isolatedServer.close();
  }
});

test("MCP L402 challenges bind price and tool, while discovery and mesh stay free", async () => {
  for (const [method, params] of [
    ["initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pricing-test", version: "1" } }],
    ["tools/list", {}],
    ["tools/call", { name: "mesh.get_status", arguments: {} }],
    ["tools/call", { name: "mesh.status", arguments: {} }],
  ] as const) {
    const { response } = await mcpRequestAt(baseUrl, method, params);
    assert.equal(response.status, 200, method);
    assert.equal(response.headers.get("www-authenticate"), null);
  }

  const lowArgs = { name: "proof.list", arguments: { limit: 10 } };
  const { response: lowResponse, body: lowChallenge } = await mcpRequestAt(baseUrl, "tools/call", lowArgs);
  assert.equal(lowResponse.status, 402);
  assert.equal((lowChallenge as any).amount_sats, 10);
  assert.match(lowResponse.headers.get("www-authenticate") ?? "", /L402 macaroon=".+", invoice="ln.+"/);
  const lowPayment = mcpInvoices.get((lowChallenge as any).payment_hash);
  assert.ok(lowPayment);
  const lowAuthorization = `L402 ${(lowChallenge as any).macaroon}:${lowPayment.preimage}`;
  const highArgs = {
    name: "proof.ground",
    arguments: { contextHash: "ab".repeat(32), agentId: "pricing-test" },
  };
  const { response: crossTier, body: highChallenge } = await mcpRequestAt(
    baseUrl, "tools/call", highArgs, undefined, lowAuthorization,
  );
  assert.equal(crossTier.status, 402);
  assert.equal((highChallenge as any).amount_sats, 250);
  const highPayment = mcpInvoices.get((highChallenge as any).payment_hash);
  assert.ok(highPayment);
  const { response: highPaid, body: highResult } = await mcpRequestAt(
    baseUrl, "tools/call", highArgs, undefined,
    `L402 ${(highChallenge as any).macaroon}:${highPayment.preimage}`,
  );
  assert.equal(highPaid.status, 200);
  const highReceipt = highResult.result?.structuredContent.receipt;
  assert.equal(highReceipt.blockHeight, 920001);
  assert.equal(highReceipt.contextHash, "ab".repeat(32));
  const verifiedGrounding = await fetch(`${baseUrl}/api/v1/zk/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attestation: highReceipt }),
  });
  assert.equal(verifiedGrounding.status, 200);
  assert.equal(((await verifiedGrounding.json()) as { valid: boolean }).valid, true);

  const { response: lowPaid } = await mcpRequestAt(
    baseUrl, "tools/call", lowArgs, undefined, lowAuthorization,
  );
  assert.equal(lowPaid.status, 200);
  const { response: replay } = await mcpRequestAt(
    baseUrl, "tools/call", lowArgs, undefined, lowAuthorization,
  );
  assert.equal(replay.status, 429);

  for (const name of ["proof.status", "proof.epistemic_receipt"]) {
    const invoicesBefore = mcpInvoiceCount;
    const { response, body } = await mcpRequestAt(baseUrl, "tools/call", {
      name,
      arguments: name === "proof.status"
        ? { snapshotDigest: "1" }
        : { cid: "ef".repeat(32) },
    });
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("www-authenticate"), null, name);
    assert.equal(body.error?.code, -32602, name);
    assert.match(body.error?.message ?? "", /unknown/i, name);
    assert.equal(mcpInvoiceCount, invoicesBefore, `${name} must not create an invoice`);
  }
});

test("MCP proof.ground reads and signs Bitcoin receipts only after L402 settles", async () => {
  const isolatedApp = express();
  isolatedApp.use(express.json());
  let tipReads = 0;
  registerMcpRoute(isolatedApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-secret",
    readBitcoinTip: async () => {
      tipReads += 1;
      return { height: 920001, hash: "ab".repeat(32), source: "contract-test" };
    },
  });
  const isolatedServer = isolatedApp.listen(0);
  try {
    await new Promise<void>((resolve) => {
      if (isolatedServer.listening) resolve();
      else isolatedServer.once("listening", resolve);
    });
    const address = isolatedServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;

    const callAfterPayment = async (
      args: Record<string, unknown>,
      forwardedFor: string,
    ) => {
      const request = { name: "proof.ground", arguments: args };
      const readsBeforeChallenge = tipReads;
      const { response: challengeResponse, body: challenge } = await mcpRequestAt(
        url, "tools/call", request, forwardedFor,
      );
      assert.equal(challengeResponse.status, 402);
      assert.equal(tipReads, readsBeforeChallenge, "L402 challenge must not perform Bitcoin-tip lookup");
      const payment = mcpInvoices.get((challenge as any).payment_hash);
      assert.ok(payment);
      const authorization = `L402 ${(challenge as any).macaroon}:${payment.preimage}`;
      const paid = await mcpRequestAt(url, "tools/call", request, forwardedFor, authorization);
      assert.equal(paid.response.status, 200);
      return { authorization, request, receipt: paid.body.result?.structuredContent.receipt };
    };

    const cidCall = await callAfterPayment(
      { cid: "Qm" + "a".repeat(44), context: { purpose: "paid-dataset" } },
      "198.51.100.71",
    );
    assert.equal(tipReads, 1);
    assert.equal(cidCall.receipt.ipfsCid, "Qm" + "a".repeat(44));
    assert.equal(cidCall.receipt.blockTip, 920001);
    const replay = await mcpRequestAt(
      url, "tools/call", cidCall.request, "198.51.100.71", cidCall.authorization,
    );
    assert.equal(replay.response.status, 429);
    assert.equal(tipReads, 1, "a replay must not repeat grounding work");

    const contextCall = await callAfterPayment(
      { contextHash: "cd".repeat(32), agentId: "paid-context" },
      "198.51.100.72",
    );
    assert.equal(contextCall.receipt.contextHash, "cd".repeat(32));
    assert.equal(contextCall.receipt.blockHeight, 920001);
    assert.equal(tipReads, 2);
  } finally {
    isolatedServer.close();
  }
});

test("rejects canonical paid tool calls in JSON-RPC batches before execution", async () => {
  const requests = [
    {
      id: 1,
      method: "tools/call",
      params: {
        name: "proof.get_by_hash",
        arguments: { hash: "1" },
      },
    },
    {
      id: 2,
      method: "tools/call",
      params: {
        name: "proof.ground",
        arguments: { cid: "ef".repeat(32) },
      },
    },
  ];
  const batches = [
    ...requests.map((request) => [request]),
    [
      {
        id: 5,
        method: "tools/call",
       params: { name: "mesh.status", arguments: {} },
      },
      requests[0],
    ],
  ];

  const assertPaidBatchRejected = async (
    batch: typeof batches[number],
    authorization?: string,
  ) => {
    const invoiceCountBefore = mcpInvoiceCount;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-03-26",
        "X-Forwarded-For": "198.51.100.42",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(batch),
    });
    const body = await response.json() as {
      jsonrpc?: string;
      id?: unknown;
      error?: { code?: number; message?: string };
    };
    assert.equal(response.status, 400, "paid batch must be rejected");
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.deepEqual(body, {
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "Batch paid tool calls are not supported",
      },
      id: null,
    });
    assert.equal(
      mcpInvoiceCount,
      invoiceCountBefore,
      "batch must be rejected before paid dispatch or invoice creation",
    );
  };
  for (const batch of batches) {
    await assertPaidBatchRejected(batch);
  }

  for (const call of [requests[1]]) {
    const challenge = await mcpRequestAt(
      baseUrl,
      "tools/call",
      call.params,
    );
    assert.equal(challenge.response.status, 402);
    const issued = challenge.body as unknown as {
      macaroon: string;
      payment_hash: string;
      amount_sats: number;
    };
    assert.equal(issued.amount_sats, 250);
    const payment = mcpInvoices.get(issued.payment_hash);
    assert.ok(payment);
    await assertPaidBatchRejected(
      [call],
      `L402 ${issued.macaroon}:${payment.preimage}`,
    );
  }
});

async function assertValidReceipt(response: Response, expectedPaymentHash: string) {
  const rawBody = await response.text();
  const receipt = JSON.parse(response.headers.get("x-l402-receipt") ?? "") as {
    payload_sha256: string;
    payment_hash: string;
    timestamp: string;
    signature: string;
  };
  assert.equal(
    receipt.payload_sha256,
    createHash("sha256").update(rawBody).digest("hex"),
  );
  assert.equal(receipt.payment_hash, expectedPaymentHash);
  assert.equal(new Date(receipt.timestamp).toISOString(), receipt.timestamp);
  assert.equal(
    receipt.signature,
    createHmac("sha256", process.env.SESSION_SECRET!)
      .update(
        receipt.payload_sha256 + receipt.payment_hash + receipt.timestamp,
      )
      .digest("hex"),
  );
  return JSON.parse(rawBody) as unknown;
}

test("keeps served and shared payment OpenAPI contracts in parity", async () => {
  const sharedDocument = parse(
    await readFile(
      resolve(process.cwd(), "../../lib/api-spec/openapi.yaml"),
      "utf8",
    ),
  ) as OpenApiDocument;
  const servedContract = paymentContract(
    openApiDocument as unknown as OpenApiDocument,
  );
  const sharedContract = paymentContract(sharedDocument);

  assert.deepEqual(servedContract, sharedContract);
  assert.deepEqual(
    (
      servedContract.sample as {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { minItems: number; maxItems: number };
              };
            };
          };
        };
      }
    ).responses["200"].content["application/json"].schema,
    {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: { $ref: "#/components/schemas/StratigraphyEntry" },
    },
  );
  assert.deepEqual(servedContract.securityScheme, {
    type: "apiKey",
    in: "header",
    name: "Authorization",
    description:
      "Legacy: L402 <payment_hash>:<preimage>. Subscription: L402 <signed_macaroon>:<preimage>.",
  });
  assert.deepEqual(servedContract.readiness, {
    security: [],
    responses: {
      "200": {
        description: "Ready to accept paid dataset requests",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReadinessStatus" },
          },
        },
      },
      "503": {
        description: "One or more payment dependencies are unavailable",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ReadinessStatus" },
          },
        },
      },
    },
  });
  assert.deepEqual(servedContract.readinessSchema, {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ready", "not_ready"] },
      dependencies: {
        type: "object",
        properties: {
          wallet_configuration: {
            type: "string",
            description:
              "Availability of either the primary Coinos or fallback Alby/NWC settlement configuration",
            enum: ["available", "unavailable"],
          },
          challenge_coordination: {
            type: "string",
            enum: ["available", "unavailable"],
          },
        },
        required: ["wallet_configuration", "challenge_coordination"],
      },
    },
    required: ["status", "dependencies"],
  });
  assert.deepEqual(
    (
      servedContract.paid.responses as Record<
        string,
        {
          content: {
            "application/json": { schema: { $ref: string } };
          };
        }
      >
    )["500"],
    {
      description: "The selected settlement asset is not configured",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/PaymentConfigurationError" },
        },
      },
    },
  );
  assert.deepEqual(
    (
      servedContract.paid.responses as Record<
        string,
        {
          headers?: Record<string, unknown>;
          content: {
            "application/json": { schema: { $ref: string } };
          };
        }
      >
    )["429"],
    {
      description: "Payment invoice creation is temporarily limited",
      headers: {
        "Retry-After": {
          description:
            "Seconds until the client may request another payment invoice",
          schema: { type: "integer", minimum: 1 },
        },
      },
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/PaymentChallengeRateLimitError",
          },
        },
      },
    },
  );
  assert.deepEqual(
    (
      servedContract.paid.responses as Record<
        string,
        {
          content: {
            "application/json": { schema: { $ref: string } };
          };
        }
      >
    )["503"],
    {
      description:
        "Payment challenge coordination or token revocation lookup is unavailable",
      content: {
        "application/json": {
          schema: {
            oneOf: [
              {
                $ref:
                  "#/components/schemas/PaymentChallengeServiceUnavailableError",
              },
              {
                $ref:
                  "#/components/schemas/TokenRevocationServiceUnavailableError",
              },
            ],
          },
        },
      },
    },
  );
  assert.deepEqual(
    (
      servedContract.paid.responses as Record<
        string,
        {
          content: {
            "application/json": { schema: { $ref: string } };
          };
        }
      >
    )["502"],
    {
      description: "The wallet could not create or verify a payment invoice",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/WalletGatewayError" },
        },
      },
    },
  );
  assert.deepEqual(servedContract.rateLimitSchema, {
    type: "object",
    properties: {
      error: {
        type: "string",
        const: "Too many payment invoices requested",
      },
      code: {
        type: "string",
        const: "payment_challenge_rate_limited",
      },
      retry_after: {
        type: "integer",
        minimum: 1,
        description:
          "Seconds until the client may request another payment invoice",
      },
    },
    required: ["error", "code", "retry_after"],
  });
  assert.deepEqual(servedContract.walletGatewaySchema, {
    type: "object",
    properties: {
      error: {
        type: "string",
        enum: [
          "Unable to create payment invoice",
          "Unable to verify payment",
        ],
      },
    },
    required: ["error"],
  });
  assert.deepEqual(servedContract.configurationErrorSchema, {
    type: "object",
    properties: {
      error: {
        type: "string",
        enum: [
          "NWC_URI is not configured",
          "Requested settlement asset is not configured",
        ],
      },
    },
    required: ["error"],
  });
  assert.deepEqual(servedContract.challengeServiceUnavailableSchema, {
    type: "object",
    properties: {
      error: {
        type: "string",
        const: "Payment challenge service unavailable",
      },
    },
    required: ["error"],
  });
});

test("reports public peer mesh status without payment", async () => {
  const response = await fetch(`${baseUrl}/api/v1/mesh/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.has("www-authenticate"), false);
  const body = (await response.json()) as {
    nodePubkey: string;
    activePeerCount: number;
    configuredPeerCount: number;
    topologyHealth: string;
    crossValidationSuccessRate: number;
    averagePropagationLatencyMs: number;
    quorumThreshold: number;
  };
  assert.match(body.nodePubkey, /^[0-9a-f]{64}$/);
  assert.equal(body.activePeerCount, 1);
  assert.equal(body.configuredPeerCount, 0);
  assert.equal(body.topologyHealth, "isolated");
  assert.equal(body.crossValidationSuccessRate, 1);
  assert.equal(body.averagePropagationLatencyMs, 0);
  assert.equal(body.quorumThreshold, 1);
});

test("keeps OpenAPI MCP tool descriptions and selector/output schemas in parity", async () => {
  const [sharedYaml, smitheryYaml, glamaJson] = await Promise.all([
    readFile(
      resolve(process.cwd(), "../../lib/api-spec/openapi.yaml"),
      "utf8",
    ),
    readFile(resolve(process.cwd(), "../../smithery.yaml"), "utf8"),
    readFile(resolve(process.cwd(), "../../glama.json"), "utf8"),
  ]);
  const sharedDocument = parse(sharedYaml) as {
    "x-mcp-tools"?: Record<string, unknown>;
    "x-mcp-tool-groups"?: unknown;
    info?: { description?: unknown };
  };
  const smitheryMetadata = parse(smitheryYaml) as { description?: unknown };
  const glamaMetadata = JSON.parse(glamaJson) as { description?: unknown };
  const xMcpTools = sharedDocument["x-mcp-tools"];
  assert.ok(
    xMcpTools && typeof xMcpTools === "object" && !Array.isArray(xMcpTools),
    "Shared OpenAPI document must define x-mcp-tools",
  );
  assert.equal(sharedDocument.info?.description, ENGINE_DESCRIPTION);
  assert.equal(smitheryMetadata.description, ENGINE_DESCRIPTION);
  assert.equal(glamaMetadata.description, ENGINE_DESCRIPTION);
  assert.equal(mcpServerCard.description, ENGINE_DESCRIPTION);

  const listed = await mcpRequest("tools/list");
  const listedTools = listed.result?.tools as Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    outputSchema: unknown;
  }>;
  assert.deepEqual(sharedDocument["x-mcp-tool-groups"], MCP_TOOL_GROUPS);
  assert.deepEqual(mcpServerCard.capabilities.toolGroups, MCP_TOOL_GROUPS);
  const groupedToolNames = Object.values(MCP_TOOL_GROUPS).flatMap(
    ({ tools }) => [...tools],
  );
  assert.equal(
    new Set(groupedToolNames).size,
    groupedToolNames.length,
    "Each canonical MCP tool must occur in exactly one group",
  );
  assert.deepEqual(
    [...groupedToolNames].sort(),
    listedTools.map(({ name }) => name).sort(),
    "MCP tool groups must cover exactly the listed canonical tools",
  );
  for (const cardTool of mcpServerCard.capabilities.tools) {
    const openApiTool = xMcpTools[cardTool.name] as {
      annotations?: unknown;
    } | undefined;
    assert.ok(openApiTool, `OpenAPI x-mcp-tools must define ${cardTool.name}`);
    assert.deepEqual(
      openApiTool.annotations,
      cardTool.annotations,
      `${cardTool.name} card and OpenAPI annotations must match`,
    );
  }
  for (const [name, expectedDescription] of Object.entries(
    expectedMcpToolDescriptions,
  )) {
    const openApiTool = xMcpTools[name] as {
      description?: unknown;
      inputSchema?: unknown;
      outputSchema?: unknown;
    } | undefined;
    assert.ok(openApiTool, `OpenAPI x-mcp-tools must define ${name}`);
    assert.equal(
      openApiTool.description,
      expectedDescription,
      `${name} OpenAPI description must match the exact public description`,
    );
    const listedTool = listedTools.find((candidate) => candidate.name === name);
    assert.ok(listedTool, `tools/list must define ${name}`);
    assert.equal(
      listedTool.description,
      expectedDescription,
      `${name} tools/list description must match the exact public description`,
    );
  }

  const requiredSchemaTools = [
    "mesh.get_status",
    "proof.get_by_hash",
    "proof.ground",
    "proof.submit",
    "proof.verify",
    "payment.get_info",
  ];
  const schemaEntries = Object.entries(xMcpTools).filter(([, candidate]) => {
    assert.ok(
      typeof candidate === "object" && candidate !== null &&
        !Array.isArray(candidate),
      "Each x-mcp-tools entry must be an object",
    );
    return Object.hasOwn(candidate, "inputSchema") ||
      Object.hasOwn(candidate, "outputSchema");
  });
  const schemaToolNames = new Set(schemaEntries.map(([name]) => name));
  for (const name of requiredSchemaTools) {
    assert.ok(
      schemaToolNames.has(name),
      `OpenAPI x-mcp-tools must define selector and output schemas for ${name}`,
    );
  }
  for (const [name, rawOpenApiTool] of schemaEntries) {
    const openApiTool = rawOpenApiTool as {
      inputSchema?: unknown;
      outputSchema?: unknown;
    };
    assert.ok(
      Object.hasOwn(openApiTool, "inputSchema") &&
        Object.hasOwn(openApiTool, "outputSchema"),
      `${name} must define both inputSchema and outputSchema`,
    );
    assert.deepEqual(
      mcpSchemaContract(openApiTool.inputSchema, `x-mcp-tools.${name}.inputSchema`),
      mcpSchemaContract(
        listedTools.find((candidate) => candidate.name === name)?.inputSchema,
        `${name}.inputSchema`,
      ),
      `${name} selector/input schema must be in parity`,
    );
    assert.deepEqual(
      mcpSchemaContract(openApiTool.outputSchema, `x-mcp-tools.${name}.outputSchema`),
      mcpSchemaContract(
        listedTools.find((candidate) => candidate.name === name)?.outputSchema,
        `${name}.outputSchema`,
      ),
      `${name} output schema must be in parity`,
    );
  }
});

test("exposes the stratigraphy MCP tool with structured quantitative data", async () => {
  const initialized = await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1.0.0" },
  });
  assert.equal(initialized.result?.serverInfo.name, "bitcoin-stratigraphy");
  assert.equal(initialized.result?.serverInfo.description, ENGINE_DESCRIPTION);
  assert.equal(initialized.result?.instructions, expectedMcpOverview);
  assert.equal(mcpServerCard.description, expectedMcpOverview);

  const listed = await mcpRequest("tools/list");
  assert.deepEqual(
    listed.result?.tools.map((candidate: { name: string }) => candidate.name),
    [
      "stratigraphy.get",
      "stratigraphy.get_digest",
      "stratigraphy.get_diff",
      "stratigraphy.get_range",
      "stratigraphy.list",
      "proof.attenuate",
      "proof.verify",
      "proof.get_by_hash",
      "proof.list",
      "proof.submit",
      "proof.ground",
      "payment.get_info",
      "mesh.get_status",
      "mesh.broadcast",
    ],
  );
  for (const unregisteredTool of ["proof.get_status", "proof.issue_receipt", "proof.verify_ots", "payment.settle"]) {
    assert.equal(
      listed.result?.tools.some((candidate: { name: string }) =>
        candidate.name === unregisteredTool
      ),
      false,
      `${unregisteredTool} must not be registered`,
    );
    assert.equal(
      mcpServerCard.capabilities.tools.some((candidate) =>
        candidate.name === unregisteredTool
      ),
      false,
      `${unregisteredTool} must not be in the server card`,
    );
  }
  assert.deepEqual(
    mcpServerCard.capabilities.tools.map((candidate) => candidate.name),
    listed.result?.tools.map((candidate: { name: string }) => candidate.name),
  );
  const listedToolNames = new Set(
    listed.result?.tools.map((candidate: { name: string }) => candidate.name),
  );
  for (const legacyName of [
    "payment.info",
    "stratigraphy.digest",
    "stratigraphy.diff",
    "stratigraphy.range",
  ]) {
    assert.equal(listedToolNames.has(legacyName), false, `${legacyName} must remain hidden`);
  }
  const openApiTools = openApiDocument["x-mcp-tools"] as Record<string, unknown>;
  for (const legacyName of [
    "payment.info",
    "stratigraphy.digest",
    "stratigraphy.diff",
    "stratigraphy.range",
  ]) {
    assert.equal(Object.hasOwn(openApiTools, legacyName), false, `${legacyName} must not be advertised in OpenAPI`);
  }
  for (const unregisteredTool of ["proof.get_status", "proof.issue_receipt", "proof.verify_ots", "payment.settle"]) {
    assert.equal(Object.hasOwn(openApiTools, unregisteredTool), false);
  }
  for (const alias of ["mesh.status", "proof.status", "proof.epistemic_receipt"]) {
    assert.equal(listedToolNames.has(alias), false, `${alias} must not be advertised`);
  }
  for (const candidate of listed.result?.tools ?? []) {
    assert.match(
      candidate.name,
      /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/,
      `${candidate.name} must use namespace.action dot notation`,
    );
  }
  const assertDocumentedSchema = (
    schema: {
      type?: unknown;
      description?: unknown;
      examples?: unknown;
      properties?: Record<string, unknown>;
      items?: unknown;
      default?: unknown;
    },
    path: string,
  ): void => {
    assert.ok(schema.type, `${path} must define type`);
    assert.ok(
      typeof schema.description === "string" &&
        schema.description.trim().length > 0,
      `${path} must define a non-empty description`,
    );
    assert.ok(
      Array.isArray(schema.examples) && schema.examples.length > 0,
      `${path} must define examples`,
    );
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      assertDocumentedSchema(
        property as Parameters<typeof assertDocumentedSchema>[0],
        `${path}.properties.${name}`,
      );
    }
    if (schema.items) {
      assertDocumentedSchema(
        schema.items as Parameters<typeof assertDocumentedSchema>[0],
        `${path}.items`,
      );
    }
  };
  const assertValidDefault = (
    schema: {
      type?: string | string[];
      default?: unknown;
      enum?: unknown[];
      const?: unknown;
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
      properties?: Record<string, unknown>;
      items?: unknown;
    },
    path: string,
  ): void => {
    if (Object.hasOwn(schema, "default")) {
      const value = schema.default;
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const matchesType = types.some((type) => {
        if (type === "integer") return Number.isSafeInteger(value);
        if (type === "number") return typeof value === "number" && Number.isFinite(value);
        if (type === "string") return typeof value === "string";
        if (type === "boolean") return typeof value === "boolean";
        if (type === "array") return Array.isArray(value);
        if (type === "object") {
          return value !== null && typeof value === "object" && !Array.isArray(value);
        }
        return false;
      });
      assert.ok(matchesType, `${path}.default must match its declared type`);
      if (typeof value === "number") {
        if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path}.default is below minimum`);
        if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path}.default exceeds maximum`);
      }
      if (typeof value === "string") {
        if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${path}.default is too short`);
        if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, `${path}.default is too long`);
        if (schema.pattern !== undefined) assert.match(value, new RegExp(schema.pattern), `${path}.default does not match pattern`);
      }
      if (Array.isArray(value)) {
        if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path}.default has too few items`);
        if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${path}.default has too many items`);
        if (schema.uniqueItems) assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${path}.default items must be unique`);
      }
      if (schema.enum) assert.ok(schema.enum.some((item) => Object.is(item, value)), `${path}.default must be in enum`);
      if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${path}.default must equal const`);
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      assertValidDefault(
        property as Parameters<typeof assertValidDefault>[0],
        `${path}.properties.${name}`,
      );
    }
    if (schema.items) {
      assertValidDefault(
        schema.items as Parameters<typeof assertValidDefault>[0],
        `${path}.items`,
      );
    }
  };
  const assertInputProperties = (
    schema: {
      type?: unknown;
      required?: unknown;
      properties?: Record<string, unknown>;
      items?: unknown;
      oneOf?: unknown[];
    },
    path: string,
    inheritedProperties: ReadonlySet<string> = new Set(),
  ): void => {
    const propertyNames = new Set([
      ...inheritedProperties,
      ...Object.keys(schema.properties ?? {}),
    ]);
    if (schema.properties) {
      assert.equal(schema.type, "object", `${path} must be an object schema`);
      const required = schema.required ?? [];
      assert.ok(Array.isArray(required), `${path}.required must be an array when present`);
      for (const name of required as string[]) {
        assert.ok(Object.hasOwn(schema.properties, name), `${path}.required includes unknown ${name}`);
      }
      for (const [name, property] of Object.entries(schema.properties)) {
        const groth16Coordinate = path.endsWith(".proof") &&
          ["pi_a", "pi_b", "pi_c"].includes(name);
        if (!(path.endsWith(".agentEvent") && name === "created_at") && !groth16Coordinate) {
          assert.match(name, /^[a-z][a-zA-Z0-9]*$/, `${path}.${name} must use camelCase`);
        }
        const documented = property as { description?: string };
        assert.match(documented.description ?? "", /example/i, `${path}.${name} must describe an example`);
        assertInputProperties(property as Parameters<typeof assertInputProperties>[0], `${path}.${name}`);
      }
    }
    for (const [index, branch] of (schema.oneOf ?? []).entries()) {
      const alternative = branch as Parameters<typeof assertInputProperties>[0];
      if (alternative.required !== undefined) {
        assert.ok(Array.isArray(alternative.required), `${path}.oneOf[${index}].required must be an array`);
        for (const name of alternative.required as string[]) {
          assert.ok(
            Object.hasOwn(alternative.properties ?? {}, name) || propertyNames.has(name),
            `${path}.oneOf[${index}].required includes unknown ${name}`,
          );
        }
      }
      assertInputProperties(alternative, `${path}.oneOf[${index}]`, propertyNames);
    }
    if (schema.items) {
      assertInputProperties(schema.items as Parameters<typeof assertInputProperties>[0], `${path}.items`);
    }
  };
  for (const candidate of listed.result?.tools ?? []) {
    if ([
      "payment.get_info", "stratigraphy.get", "stratigraphy.list",
      "stratigraphy.get_range", "stratigraphy.get_digest", "stratigraphy.get_diff",
      "proof.verify", "proof.get_by_hash", "proof.list", "proof.attenuate", "mesh.get_status",
    ].includes(candidate.name)) {
      assert.equal(candidate.description, expectedMcpToolDescriptions[candidate.name]);
    } else {
      assert.match(candidate.description, /^PURPOSE & BOUNDARIES: .+/,
        `${candidate.name} must identify its purpose`);
      assert.match(candidate.description, /USAGE GUIDELINES: .+/,
        `${candidate.name} must explain when to use it`);
      assert.match(candidate.description, /BEHAVIOR & CONSEQUENCES: .+/,
        `${candidate.name} must explain cost and failures`);
    }
    if (candidate.name === "proof.list") {
      assert.match(candidate.description, /costs 10 sats/);
    }
    assertDocumentedSchema(candidate.inputSchema, `${candidate.name}.inputSchema`);
    assertValidDefault(candidate.inputSchema, `${candidate.name}.inputSchema`);
    assertInputProperties(candidate.inputSchema, `${candidate.name}.inputSchema`);
    assertDocumentedSchema(
      candidate.outputSchema,
      `${candidate.name}.outputSchema`,
    );
  }
  for (const candidate of listed.result?.tools ?? []) {
    if (!Object.hasOwn(expectedMcpToolDescriptions, candidate.name)) {
      assert.match(candidate.description, /\b(?:not to|not for|do not)\b/i,
        `${candidate.name} must distinguish nearby tools`);
    }
  }
  const expectedContracts: Record<string, {
    keys: string[];
    readOnly: boolean;
    idempotent: boolean;
    openWorld: boolean;
  }> = {
    "stratigraphy.list": {
      keys: ["totalSnapshots", "oldestBlock", "newestBlock", "availableMetrics", "dateBounds"],
      readOnly: true, idempotent: true, openWorld: false,
    },
    "stratigraphy.get": {
      keys: ["records"], readOnly: true, idempotent: true, openWorld: false,
    },
    "stratigraphy.get_digest": {
      keys: ["result", "proofAvailable"], readOnly: true, idempotent: true, openWorld: false,
    },
    "stratigraphy.get_diff": {
      keys: ["from", "to", "delta"], readOnly: true, idempotent: true, openWorld: false,
    },
    "stratigraphy.get_range": {
      keys: ["range", "count", "format", "records"],
      readOnly: true, idempotent: true, openWorld: false,
    },
    "proof.attenuate": {
      keys: ["status", "attenuatedMacaroon", "appliedCaveats", "issuedAt"],
      readOnly: true, idempotent: true, openWorld: false,
    },
    "mesh.get_status": {
      keys: ["nodePubkey", "activePeerCount", "configuredPeerCount", "topologyHealth",
        "crossValidationSuccessRate", "averagePropagationLatencyMs", "quorumThreshold"],
      readOnly: true, idempotent: true, openWorld: true,
    },
    "mesh.broadcast": {
      keys: ["signalType", "date", "snapshotDigest", "peerAttestations",
        "quorumThreshold", "merkleRoot", "networkId", "agentPubkey"],
      readOnly: false, idempotent: false, openWorld: true,
    },
    "proof.ground": {
      keys: ["receipt", "provenanceVerified", "provenanceMerkleRoot", "otsProof", "otsStatus"],
      readOnly: false, idempotent: false, openWorld: true,
    },
    "proof.list": {
      keys: ["attestations", "total"], readOnly: true, idempotent: true, openWorld: false,
    },
    "proof.get_by_hash": {
      keys: ["kind", "hash", "status", "timestamp", "jobId", "attestationCount",
        "meshQuorum", "proofPayload", "provenanceVerified", "provenanceMerkleRoot", "otsProof", "otsStatus"],
      readOnly: true, idempotent: true, openWorld: false,
    },
    "payment.get_info": {
      keys: ["standardInvoiceSats", "perToolSats", "acceptedPaymentMethods",
        "invoiceExpirySeconds", "challenge", "activeAuthSchemes", "macaroonRequirements", "verified", "settlementToken"],
      readOnly: false, idempotent: false, openWorld: true,
    },
    "proof.verify": {
      keys: ["valid", "verifiedAt", "computationTimeMs", "status", "blockHeight", "bitcoinHeaderHash"],
      readOnly: false, idempotent: false, openWorld: true,
    },
    "proof.submit": {
      keys: ["proofHash", "jobId", "status", "submittedAt", "attestationStatus"],
      readOnly: false, idempotent: false, openWorld: true,
    },
  };
  for (const candidate of listed.result?.tools ?? []) {
    const expected = expectedContracts[candidate.name];
    assert.ok(expected, `${candidate.name} must have a documented runtime contract`);
    assert.equal(candidate.outputSchema.additionalProperties, false);
    const outputKeys = candidate.name === "payment.get_info"
      ? [...expected.keys, "x402"]
      : expected.keys;
    assert.deepEqual(Object.keys(candidate.outputSchema.properties).sort(), [...outputKeys].sort(),
      `${candidate.name} outputSchema must describe the returned JSON fields`);
    const expectedRequired = candidate.name === "payment.get_info"
      ? []
      : candidate.name === "proof.verify"
        ? ["valid"]
        : candidate.name === "proof.get_by_hash"
      ? ["kind", "hash", "status", "timestamp", "provenanceVerified"]
      : candidate.name === "mesh.broadcast"
        ? expected.keys.filter((key) => key !== "agentPubkey")
        : candidate.name === "proof.ground"
          ? ["receipt", "provenanceVerified"]
          : expected.keys;
    assert.deepEqual([...candidate.outputSchema.required].sort(),
      [...expectedRequired].sort());
    if (candidate.name === "proof.get_by_hash") {
      const payloadExample = candidate.outputSchema.examples[0] as Record<string, unknown>;
      assert.equal(payloadExample.kind, "zk-proof");
      assert.ok(Object.hasOwn(payloadExample, "proofPayload"));
      assert.ok(Object.hasOwn(payloadExample, "timestamp"));
    } else if (candidate.name !== "payment.get_info" && candidate.name !== "proof.verify") {
      assert.deepEqual(Object.keys(candidate.outputSchema.examples[0]).sort(), [...expectedRequired].sort());
    }
    assert.equal(candidate.annotations.readOnlyHint, expected.readOnly);
    assert.equal(candidate.annotations.idempotentHint, expected.idempotent);
    assert.equal(candidate.annotations.openWorldHint, expected.openWorld);
  }
  const documentedTool = (name: string) => listed.result?.tools.find(
    (candidate: { name: string }) => candidate.name === name,
  );
  for (const [name, description] of Object.entries(expectedMcpToolDescriptions)) {
    assert.equal(
      documentedTool(name).description,
      description,
      `${name} description must exactly match the public MCP contract`,
    );
  }
  for (const name of ["mesh.get_status", "proof.get_by_hash", "payment.get_info"]) {
    assert.doesNotMatch(
      documentedTool(name).description,
      /Note: Stratigraphy records and zk-SNARK proofs are append-only/,
      `${name} must not append the generic immutability note to its exact description`,
    );
  }
  assert.match(documentedTool("stratigraphy.list").description, /^Discover indexed height and UTC date bounds, available metrics, and catalog metadata\./);
  assert.match(documentedTool("proof.list").description, /costs 10 sats/);
  assert.match(documentedTool("mesh.broadcast").inputSchema.properties.payload.description,
    /date selector.*not a caller-supplied record/i);
  assert.match(documentedTool("proof.list").inputSchema.properties.offset.description,
    /multiples of limit are not required/);
  assert.match(documentedTool("stratigraphy.get").inputSchema.properties.startDate.description,
    /open range/);
  const queryDefaults = listed.result?.tools.find(
    (candidate: { name: string }) => candidate.name === "stratigraphy.get",
  )?.inputSchema.properties;
  assert.equal(queryDefaults.limit.default, 10);
  assert.equal(Object.hasOwn(queryDefaults.days, "default"), false);
  assert.equal(Object.hasOwn(queryDefaults.date, "default"), false);
  const listDefaults = listed.result?.tools.find(
    (candidate: { name: string }) => candidate.name === "proof.list",
  )?.inputSchema.properties;
  assert.equal(listDefaults.limit.default, 20);
  assert.equal(listDefaults.offset.default, 0);
  const groundingTool = listed.result?.tools.find(
    (candidate: { name: string }) => candidate.name === "proof.ground",
  );
  assert.ok(groundingTool);
  const groundingCalled = await mcpRequest("tools/call", {
    name: "proof.ground",
    arguments: {
      contextHash:
        "4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f",
      agentId: "contract-agent",
      metadata: { purpose: "contract-test" },
    },
  });
  assert.notEqual(groundingCalled.result?.isError, true);
  const receipt = groundingCalled.result?.structuredContent.receipt;
  assert.equal(groundingCalled.result?.structuredContent.provenanceVerified, true);
  assert.equal(receipt.contextHash, "4f".repeat(32));
  assert.equal(receipt.agentId, "contract-agent");
  assert.equal(receipt.blockHeight, 920001);
  assert.equal(receipt.blockHash, "ab".repeat(32));
  const verifiedMcpReceipt = await fetch(`${baseUrl}/api/v1/zk/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attestation: receipt }),
  });
  assert.equal(verifiedMcpReceipt.status, 200);
  assert.equal(((await verifiedMcpReceipt.json()) as { valid: boolean }).valid, true);
  const groundInput = groundingTool.inputSchema.properties;
  assert.ok(Object.hasOwn(groundInput, "contextHash"));
  assert.ok(Object.hasOwn(groundInput, "cid"));
  assert.ok(Object.hasOwn(groundInput, "context"));
  const datasetArgs = {
    cid: "ab".repeat(32),
    nostrEventId: "cd".repeat(32),
    context: { purpose: "contract-test" },
  };
  const datasetCalled = await mcpRequest("tools/call", {
    name: "proof.ground",
    arguments: datasetArgs,
  });
  const datasetReceipt = datasetCalled.result?.structuredContent.receipt;
  assert.equal(datasetReceipt.blockTip, 920001);
  assert.equal(datasetReceipt.blockHash, "ab".repeat(32));
  assert.equal(datasetReceipt.ipfsCid, datasetArgs.cid);
  assert.equal(datasetReceipt.attestation.verified, true);
  assert.equal(verifyEpistemicDatasetReceipt(datasetReceipt), true);
  const signedDatasetReceipt = JSON.parse(datasetReceipt.attestation.proofPayload);
  assert.equal(signedDatasetReceipt.payload.metadata.cid, datasetArgs.cid);
  assert.equal(signedDatasetReceipt.payload.metadata.nostrEventId, datasetArgs.nostrEventId);
  assert.equal(signedDatasetReceipt.payload.metadata.context.purpose, datasetArgs.context.purpose);
  assert.match(signedDatasetReceipt.payload.metadata.context.datasetProvenance.merkleRoot, /^[0-9a-f]{64}$/);
  assert.equal(datasetCalled.result?.structuredContent.provenanceVerified, true);
  const verifyDatasetReceipt = async (attestation: unknown) => {
    const response = await fetch(`${baseUrl}/api/v1/zk/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attestation }),
    });
    assert.equal(response.status, 200);
    return (await response.json() as { valid: boolean }).valid;
  };
  assert.equal(await verifyDatasetReceipt(signedDatasetReceipt), true);
  assert.equal(await verifyDatasetReceipt({
    ...signedDatasetReceipt,
    payload: { ...signedDatasetReceipt.payload, metadata: {
      ...signedDatasetReceipt.payload.metadata, cid: "ef".repeat(32),
    } },
  }), false);
  for (const hash of [datasetReceipt.receiptHash, datasetArgs.cid]) {
    const datasetFound = await mcpRequest("tools/call", {
      name: "proof.get_by_hash", arguments: { hash },
    });
    assert.equal(datasetFound.result?.structuredContent.kind, "dataset-receipt");
    assert.equal(datasetFound.result?.structuredContent.status, "verified");
    assert.equal(datasetFound.result?.structuredContent.provenanceVerified, true);
    assert.equal(
      datasetFound.result?.structuredContent.provenanceMerkleRoot,
      signedDatasetReceipt.payload.metadata.context.datasetProvenance.merkleRoot,
    );
    if (datasetFound.result?.structuredContent.otsProof) {
      assert.match(datasetFound.result.structuredContent.otsProof, /^[A-Za-z0-9+/]+={0,2}$/);
      assert.ok(["pending_calendar", "bitcoin_block_attested"].includes(
        datasetFound.result.structuredContent.otsStatus,
      ));
    }
    assert.deepEqual(
      datasetFound.result?.structuredContent.proofPayload,
      datasetReceipt,
    );
  }
  const tool = listed.result?.tools.find(
    (candidate: { name: string }) =>
      candidate.name === "stratigraphy.get",
  );
  assert.ok(tool);
  const queryProperties = tool.inputSchema.properties as Record<
    string,
    { type?: unknown; description?: unknown; example?: unknown }
  >;
  assert.deepEqual(Object.keys(queryProperties), [
    "days",
    "date",
    "blockHeight",
    "metrics",
    "startDate",
    "endDate",
    "startBlock",
    "endBlock",
    "limit",
  ]);
  for (const [name, property] of Object.entries(queryProperties)) {
    assert.ok(property.type, `${name} must define type`);
    assert.equal(
      typeof property.description,
      "string",
      `${name} must define description`,
    );
    assert.ok(
      Object.hasOwn(property, "example"),
      `${name} must define a concrete example`,
    );
  }
  const metricItem = (queryProperties.metrics as {
    items: { type: string; description: string; enum: string[]; example: string };
  }).items;
  assert.equal(metricItem.type, "string");
  assert.match(metricItem.description, /target_multiplier/);
  assert.equal(metricItem.example, "target_multiplier");
  assert.deepEqual(metricItem.enum, [
    "target_multiplier",
    "difficulty_epoch_progress",
    "thermodynamic_signal",
  ]);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnly: true,
    audience: ["assistant"],
    priority: 1,
    zkProof: {
      included: true,
      scheme: "Groth16/Poseidon BN254",
      verificationEndpoint: "POST /api/v1/zk/verify",
      targetVerificationTime: "sub-10ms for proofs emitted by this API",
    },
  });
  assert.deepEqual((await mcpRequest("resources/list")).result, {
    resources: [],
  });
  assert.deepEqual((await mcpRequest("prompts/list")).result, {
    prompts: [],
  });

  const called = await mcpRequest("tools/call", {
    name: "stratigraphy.get",
    arguments: { date: "2026-09-09" },
  });
  const records = called.result?.structuredContent.records as Array<{
    day: number;
    quantitative_alpha: {
      target_multiplier: number;
      difficulty_epoch_progress: string;
      thermodynamic_signal: string;
    };
  }>;
  assert.equal(records.length, 1);
  assert.equal(records[0].day, 422);
  assert.equal(records[0].quantitative_alpha.target_multiplier, 125.83);
  assert.match(
    records[0].quantitative_alpha.difficulty_epoch_progress,
    /%$/,
  );
  assert.equal(
    typeof records[0].quantitative_alpha.thermodynamic_signal,
    "string",
  );

  const dateRangeCalled = await mcpRequest("tools/call", {
    name: "stratigraphy.get",
    arguments: {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      limit: 5,
    },
  });
  assert.equal(dateRangeCalled.result?.structuredContent.records.length, 5);

  const blockRangeCalled = await mcpRequest("tools/call", {
    name: "stratigraphy.get",
    arguments: {
      startBlock: 919000,
      endBlock: 920000,
      limit: 4,
    },
  });
  assert.equal(blockRangeCalled.result?.structuredContent.records.length, 4);

  const exactBlockCalled = await mcpRequest("tools/call", {
    name: "stratigraphy.get",
    arguments: {
      blockHeight: 920000,
      metrics: ["target_multiplier"],
    },
  });
  assert.equal(exactBlockCalled.result?.structuredContent.records.length, 1);
  assert.deepEqual(
    exactBlockCalled.result?.structuredContent.records[0].quantitative_alpha,
    { target_multiplier: 125.83 },
  );

  const catalogCalled = await mcpRequest("tools/call", {
    name: "stratigraphy.list",
    arguments: {},
  });
  assert.deepEqual(catalogCalled.result?.structuredContent.dateBounds, {
    startDate: "2025-07-15",
    endDate: "2026-09-09",
  });
  assert.equal(catalogCalled.result?.structuredContent.totalSnapshots, 422);
  assert.equal(catalogCalled.result?.structuredContent.oldestBlock, 859376);
  assert.equal(catalogCalled.result?.structuredContent.newestBlock, 920000);
  assert.ok(
    catalogCalled.result?.structuredContent.availableMetrics.includes(
      "quantitative_alpha.target_multiplier",
    ),
  );

  const meshCalled = await mcpRequest("tools/call", {
    name: "mesh.get_status",
    arguments: {},
  });
  assert.equal(meshCalled.result?.structuredContent.topologyHealth, "isolated");
  assert.equal(meshCalled.result?.structuredContent.quorumThreshold, 1);

  const proofCalled = await mcpRequest("tools/call", {
    name: "proof.verify",
    arguments: {
      proof: "invalid-proof",
      publicInputs: {
        blockHeight: 920000,
        snapshotDigest: "1",
        thermodynamicHash: "1",
        timestamp: 1789776000000,
        valuationSat: 12583,
      },
      verificationKeyId: "sha256:unknown",
      data: [{
        block: { height: 920000 },
        observed_at: "2026-09-19T00:00:00.000Z",
        thermodynamic: { target_multiplier: 125.83 },
      }],
    },
  });
  assert.equal(proofCalled.result?.structuredContent.valid, false);
  assert.equal(
    typeof proofCalled.result?.structuredContent.computationTimeMs,
    "number",
  );

  const submitted = await mcpRequest("tools/call", {
    name: "proof.submit",
    arguments: {
      proof: {
        pi_a: ["1", "2", "1"],
        pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
        pi_c: ["5", "6", "1"],
      },
      publicSignals: ["920000", "1", "1789776000000", "12583", "1"],
      snapshotDigest: "1",
    },
  });
  assert.equal(submitted.result?.structuredContent.status, "invalid");
  assert.match(
    submitted.result?.structuredContent.jobId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  for (const hash of ["1", submitted.result?.structuredContent.jobId]) {
    const statusOnly = await mcpRequest("tools/call", {
      name: "proof.get_by_hash",
      arguments: { hash },
    });
    assert.equal(statusOnly.result?.structuredContent.status, "invalid");
    assert.equal(statusOnly.result?.structuredContent.kind, hash === "1" ? "zk-proof-status" : "zk-proof");
    assert.equal(typeof statusOnly.result?.structuredContent.timestamp, "string");
    assert.equal(Object.hasOwn(statusOnly.result?.structuredContent, "proofPayload"), hash !== "1");
  }
  const camelCaseSubmitted = await mcpRequest("tools/call", {
    name: "proof.submit",
    arguments: {
      proof: {
        piA: ["1", "2", "1"],
        piB: [["1", "2"], ["3", "4"], ["1", "0"]],
        piC: ["5", "6", "1"],
      },
      publicSignals: ["920000", "1", "1789776000000", "12583", "1"],
      snapshotDigest: "1",
    },
  });
  assert.equal(camelCaseSubmitted.result?.structuredContent.status, "invalid");
  assert.equal(
    camelCaseSubmitted.result?.structuredContent.proofHash,
    submitted.result?.structuredContent.proofHash,
    "camelCase and legacy Groth16 coordinate names must produce the same canonical proof",
  );
  assert.equal(
    submitted.result?.structuredContent.attestationStatus,
    "not_broadcast_invalid_proof",
  );
  assert.match(
    submitted.result?.structuredContent.proofHash,
    /^0x[0-9a-f]{64}$/,
  );

  const submittedStatus = await mcpRequest("tools/call", {
    name: "proof.get_by_hash",
    arguments: {
      hash: submitted.result?.structuredContent.proofHash,
    },
  });
  assert.equal(submittedStatus.result?.structuredContent.status, "invalid");

  const listedAttestations = await mcpRequest("tools/call", {
    name: "proof.list",
    arguments: { limit: 10, status: "invalid" },
  });
  assert.ok(listedAttestations.result?.structuredContent.total >= 1);
  const submittedAttestation =
    listedAttestations.result?.structuredContent.attestations.find(
      (record: { proofHash: string }) =>
        record.proofHash === submitted.result?.structuredContent.proofHash,
    );
  assert.deepEqual(
    {
      snapshotDigest: submittedAttestation?.snapshotDigest,
      status: submittedAttestation?.status,
      attestationCount: submittedAttestation?.attestationCount,
      meshQuorum: submittedAttestation?.meshQuorum,
    },
    {
      snapshotDigest: "1",
      status: "invalid",
      attestationCount: 0,
      meshQuorum: false,
    },
  );
});

test("MCP quotes both rails without a facilitator but refuses signed x402 requests", async () => {
  const app = express();
  app.use(express.json());
  registerMcpRequestGuard(app);
  registerMcpRoute(app, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-no-facilitator-secret",
    x402ResourceServer: null,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const name of ["payment.info", "stratigraphy.list"]) {
      const free = await mcpRequestAt(baseUrl, "tools/call", { name, arguments: {} });
      assert.equal(free.response.status, 200);
      assert.ok(free.body.result?.structuredContent);
      assert.equal(free.response.headers.get("payment-required"), null);
    }
    const challenge = await mcpRequestAt(baseUrl, "tools/call", {
      name: "stratigraphy.get", arguments: { days: 1 },
    });
    assert.equal(challenge.response.status, 402);
    assert.match(challenge.response.headers.get("www-authenticate") ?? "", /L402 macaroon="[^"]+", invoice="[^"]+"/);
    const encoded = challenge.response.headers.get("payment-required");
    assert.ok(encoded);
    const terms = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      x402Version: number;
      resource: { url: string };
      accepts: Array<{ amount: string; asset: string; payTo: string; network: string; extra: Record<string, unknown> }>;
    };
    assert.equal(terms.x402Version, 2);
    assert.equal(terms.resource.url, `${baseUrl}/mcp`);
    assert.equal(terms.accepts[0]?.amount, "1000");
    assert.equal(terms.accepts[0]?.asset.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(terms.accepts[0]?.payTo.toLowerCase(), (process.env.X402_RECEIVING_ADDRESS ?? "0x7a4183ce5b9989833bb33133dcbb8efd6a84e775").toLowerCase());
    assert.equal(terms.accepts[0]?.network, "eip155:8453");
    assert.equal(terms.accepts[0]?.extra.displayAmount, "0.001");
    assert.equal(terms.accepts[0]?.extra.settlementAvailable, false);
    const attempted = await mcpRequestAt(
      baseUrl, "tools/call", { name: "stratigraphy.get", arguments: { days: 1 } },
      undefined, undefined, Buffer.from("{}").toString("base64"),
    );
    assert.equal(attempted.response.status, 503);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("MCP request logging excludes query-string credentials", () => {
  let guard: express.RequestHandler | undefined;
  registerMcpRequestGuard({
    use: (_path: string, middleware: express.RequestHandler) => {
      guard = middleware;
    },
  } as unknown as express.Express);
  assert.ok(guard);
  const entries: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { entries.push(args); };
  try {
    guard({
      method: "POST",
      headers: {},
      path: "/",
      url: "/?api_key=credential-sentinel",
    } as unknown as express.Request, {} as express.Response, () => undefined);
  } finally {
    console.log = originalLog;
  }
  assert.equal(entries[0]?.at(-1), "/");
  assert.doesNotMatch(JSON.stringify(entries), /credential-sentinel/);
});

test("MCP forwards failed L402 usage accounting to its JSON error handler", async () => {
  const isolatedApp = express();
  isolatedApp.use(express.json());
  registerMcpRoute(isolatedApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-usage-failure-secret",
    x402ResourceServer: null,
    usageStore: {
      consume: async () => { throw new Error("Usage store unavailable"); },
    },
  });
  const server = isolatedApp.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const args = { name: "stratigraphy.get", arguments: { days: 1 } };
    const challenge = await mcpRequestAt(url, "tools/call", args);
    assert.equal(challenge.response.status, 402);
    const offer = challenge.body as unknown as { macaroon: string; payment_hash: string };
    const payment = mcpInvoices.get(offer.payment_hash);
    assert.ok(payment);
    const paid = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `L402 ${offer.macaroon}:${payment.preimage}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: args,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(paid.status, 500);
    const body = await paid.json() as { error?: { code: number; message: string } };
    assert.equal(body.error?.code, -32603);
    assert.equal(body.error?.message, "Internal server error");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("MCP paid tools issue dual challenges and settle x402 before execution", async () => {
  let facilitatorSettlesPayment = true;
  let verifyCalls = 0;
  let settleCalls = 0;
  const facilitator: FacilitatorClient = {
    verify: async () => {
      verifyCalls += 1;
      return { isValid: true };
    },
    settle: async () => {
      settleCalls += 1;
      return {
        success: facilitatorSettlesPayment,
        transaction: facilitatorSettlesPayment ? "0x" + "ab".repeat(32) : "",
        network: "eip155:8453",
        amount: "1000",
        ...(!facilitatorSettlesPayment
          ? { errorReason: "invalid_signature", errorMessage: "Invalid payment signature" }
          : {}),
      };
    },
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
      extensions: [],
      signers: {},
    }),
  };
  const x402Server = new x402ResourceServer(facilitator)
    .register("eip155:8453", new ExactEvmScheme());
  const paymentApp = express();
  paymentApp.use(express.json());
  registerMcpRequestGuard(paymentApp);
  registerMcpRoute(paymentApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-x402-secret",
    x402ResourceServer: x402Server,
  });
  const server = paymentApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const free = await mcpRequestAt(baseUrl, "tools/call", {
      name: "payment.info", arguments: {},
    });
    assert.equal(free.response.status, 200);
    assert.equal(free.body.result?.structuredContent.x402.amount, "1000");
    assert.equal(free.response.headers.get("payment-required"), null);

    const catalog = await mcpRequestAt(baseUrl, "tools/call", {
      name: "stratigraphy.list", arguments: {},
    });
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.response.headers.get("payment-required"), null);
    assert.equal(catalog.body.result?.structuredContent.totalSnapshots, 422);

    const params = { name: "proof.list", arguments: {} };
    const challenge = await mcpRequestAt(baseUrl, "tools/call", params);
    assert.equal(challenge.response.status, 402);
    assert.match(challenge.response.headers.get("www-authenticate") ?? "", /^L402 /);
    const encoded = challenge.response.headers.get("payment-required");
    assert.ok(encoded);
    const paymentRequired = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as {
      x402Version: number;
      resource: { url: string };
      accepts: Array<Record<string, unknown>>;
    };
    assert.equal(paymentRequired.x402Version, 2);
    assert.equal(paymentRequired.accepts[0]?.amount, "1000");
    assert.equal(paymentRequired.accepts[0]?.network, "eip155:8453");
    assert.equal(
      (paymentRequired.accepts[0]?.extra as { paymentFlow?: string }).paymentFlow,
      "upfront",
    );
    assert.equal((challenge.body as { amount_sats?: number }).amount_sats, 10);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: paymentRequired.accepts[0] as PaymentPayload["accepted"],
      payload: { signature: "facilitator-test-signature" },
    };
    const paymentSignature = Buffer.from(JSON.stringify(payload)).toString("base64");

    facilitatorSettlesPayment = false;
    const invalid = await mcpRequestAt(
      baseUrl, "tools/call", params, undefined, undefined, paymentSignature,
    );
    assert.equal(invalid.response.status, 502);
    assert.equal(verifyCalls, 0);
    assert.equal(settleCalls, 1);

    facilitatorSettlesPayment = true;
    const paid = await mcpRequestAt(
      baseUrl, "tools/call", params, undefined, undefined, paymentSignature,
    );
    assert.equal(paid.response.status, 200);
    assert.equal(verifyCalls, 0);
    assert.equal(settleCalls, 2);

    facilitatorSettlesPayment = false;
    const retried = await mcpRequestAt(
      baseUrl, "tools/call", params, undefined, undefined, paymentSignature,
    );
    assert.equal(retried.response.status, 502);
    assert.equal(verifyCalls, 0);
    assert.equal(settleCalls, 3);

    const wrongTerms = {
      ...payload,
      accepted: { ...payload.accepted, amount: "1001" },
    };
    const rejectedTerms = await mcpRequestAt(
      baseUrl,
      "tools/call",
      params,
      undefined,
      undefined,
      Buffer.from(JSON.stringify(wrongTerms)).toString("base64"),
    );
    assert.equal(rejectedTerms.response.status, 400);
    assert.equal(verifyCalls, 0);
    assert.equal(settleCalls, 3);
    for (const invalidPayload of [
      { ...payload, x402Version: 1 },
      { ...payload, resource: { url: `${paymentRequired.resource.url}/wrong` } },
    ]) {
      const rejected = await mcpRequestAt(
        baseUrl,
        "tools/call",
        params,
        undefined,
        undefined,
        Buffer.from(JSON.stringify(invalidPayload)).toString("base64"),
      );
      assert.equal(rejected.response.status, 400);
    }
    assert.equal(verifyCalls, 0);
    assert.equal(settleCalls, 3);
    const baseTxHash = "0x" + "ab".repeat(32);
    const mismatch = await mcpRequestAt(
      baseUrl, "tools/call", {
        name: "payment.info",
        arguments: { action: "settle", paymentHash: "0x" + "cd".repeat(32), txHash: baseTxHash },
      }, undefined, undefined, paymentSignature,
    );
    assert.deepEqual(mismatch.body.result?.structuredContent, {
      verified: false, settlementToken: null,
    });
    assert.equal(settleCalls, 3, "Mismatched payment references must not trigger settlement");
    facilitatorSettlesPayment = true;
    const baseSettlement = await mcpRequestAt(
      baseUrl, "tools/call", {
        name: "payment.info",
        arguments: { action: "settle", paymentHash: baseTxHash, txHash: baseTxHash },
      }, undefined, undefined, paymentSignature,
    );
    assert.equal(baseSettlement.body.result?.structuredContent.verified, true);
    assert.equal(baseSettlement.body.result?.structuredContent.settlementToken.paymentHash, baseTxHash);
    assert.equal(baseSettlement.body.result?.structuredContent.settlementToken.scope, "/mcp");
    assert.equal(settleCalls, 4);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("returns a paid digest of stored records without inventing a block hash or proof", async () => {
  // Isolate the digest checks from the shared 60-request/minute MCP test server.
  const digestApp = express();
  digestApp.use(express.json());
  registerMcpRequestGuard(digestApp);
  registerMcpRoute(digestApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-secret",
  });
  const digestServer = digestApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => digestServer.once("listening", resolve));
  const digestBase = `http://127.0.0.1:${(digestServer.address() as AddressInfo).port}`;
  try {
  const listed = (await mcpRequestAt(digestBase, "tools/list")).body;
  const tool = listed.result?.tools.find(
    (candidate: { name: string }) => candidate.name === "stratigraphy.get_digest",
  );
  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.format.default, "compact");
  assert.equal(tool.inputSchema.properties.target.default, "latest");
  assert.deepEqual(tool.inputSchema.properties.format.enum, ["compact", "minimal", "kv"]);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.idempotentHint, true);
  assert.equal(tool.annotations.zkProof, undefined);

  const source = (await readDataset()).at(-1)!;
  const expectedHash = createHash("sha256").update(JSON.stringify([
    source.day, source.title, source.video_id, source.transcript_summary,
    source.quantitative_alpha.target_multiplier,
    source.quantitative_alpha.difficulty_epoch_progress,
    source.quantitative_alpha.thermodynamic_signal,
  ])).digest("hex");
  const multiplier = source.quantitative_alpha.target_multiplier;
  const compact = `HEIGHT:920000|DATE:2026-09-09|TM:${multiplier}|HASH:${expectedHash}`;
  const callDigest = async (
    args: Record<string, unknown>,
    invokedName = "stratigraphy.get_digest",
    assertAliasScope = false,
  ) => {
    const params = { name: invokedName, arguments: args };
    const challenge = await mcpRequestAt(digestBase, "tools/call", params);
    assert.equal(challenge.response.status, 402);
    const offer = challenge.body as unknown as { amount_sats: number; macaroon: string; payment_hash: string };
    assert.equal(offer.amount_sats, 250);
    const verified = verifySubscriptionMacaroon(
      offer.macaroon, "contract-mcp-secret", Math.floor(Date.now() / 1000),
    );
    assert.ok(verified);
    assert.deepEqual(verified.allowedPaths, [`/mcp/tools/${invokedName}`]);
    const payment = mcpInvoices.get(offer.payment_hash);
    assert.ok(payment);
    if (assertAliasScope) {
      const otherName = invokedName === "stratigraphy.get_digest"
        ? "stratigraphy.digest"
        : "stratigraphy.get_digest";
      const bypass = await mcpRequestAt(
        digestBase, "tools/call", { name: otherName, arguments: args }, undefined,
        `L402 ${offer.macaroon}:${payment.preimage}`,
      );
      assert.equal(bypass.response.status, 402);
      assert.notEqual((bypass.body as { payment_hash?: string }).payment_hash, offer.payment_hash);
    }
    const paid = await mcpRequestAt(digestBase, "tools/call", params, undefined,
      `L402 ${offer.macaroon}:${payment.preimage}`);
    assert.equal(paid.response.status, 200);
    return paid.body;
  };
  const canonicalDigest = await callDigest({}, "stratigraphy.get_digest", true);
  const legacyDigest = await callDigest({}, "stratigraphy.digest", true);
  assert.deepEqual(
    legacyDigest.result?.structuredContent,
    canonicalDigest.result?.structuredContent,
    "legacy and canonical digest calls must both be functional at the same price",
  );
  for (const [args, expected] of [
    [{}, compact],
    [{ target: "920000", format: "minimal" }, [920000, "2026-09-09", multiplier, expectedHash]],
    [{ target: "2026-09-09", format: "kv" }, {
      h: 920000, ts: "2026-09-09", tm: multiplier, hash: expectedHash,
    }],
    [{ target: "2026-09-08..2026-09-09", format: "kv" }, null],
  ] as const) {
    const called = await callDigest(args);
    const content = called.result?.content;
    assert.deepEqual(content.map((item: { type: string }) => item.type), ["text"]);
    const result = JSON.parse(content[0].text);
    assert.deepEqual(called.result?.structuredContent.result, result);
    assert.equal(called.result?.structuredContent.proofAvailable, false);
    if (expected === null) {
      assert.equal(result.length, 2);
      assert.equal(result[1].hash, expectedHash);
      assert.equal(result[0].ts, "2026-09-08");
    } else {
      assert.deepEqual(result, expected);
    }
  }
  for (const target of ["2026-09-27", "862401", "2026-09-09..2026-09-08"]) {
    const invalid = await mcpRequestAt(digestBase, "tools/call", {
      name: "stratigraphy.get_digest", arguments: { target },
    });
    assert.ok([200, 400].includes(invalid.response.status));
    assert.equal(invalid.body.error?.code, -32602);
    assert.equal(invalid.response.headers.get("www-authenticate"), null);
  }
  } finally {
    await new Promise<void>((resolve, reject) =>
      digestServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("compares two paid indexed strata with signed height, multiplier, percentage, and day deltas", async () => {
  const diffApp = express();
  diffApp.use(express.json());
  registerMcpRequestGuard(diffApp);
  registerMcpRoute(diffApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-secret",
  });
  const diffServer = diffApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => diffServer.once("listening", resolve));
  const diffBase = `http://127.0.0.1:${(diffServer.address() as AddressInfo).port}`;
  try {
    const listed = (await mcpRequestAt(diffBase, "tools/list")).body;
    const tool = listed.result?.tools.find(
      (candidate: { name: string }) => candidate.name === "stratigraphy.get_diff",
    );
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["fromTarget"]);
    assert.equal(tool.inputSchema.properties.toTarget.default, "latest");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.idempotentHint, true);

    const [previous, current] = (await readDataset()).slice(-2);
    const fromMultiplier = previous.quantitative_alpha.target_multiplier;
    const toMultiplier = current.quantitative_alpha.target_multiplier;
    const expected = {
      from: { height: 919856, date: "2026-09-08", target_multiplier: fromMultiplier },
      to: { height: 920000, date: "2026-09-09", target_multiplier: toMultiplier },
      delta: {
        heightDelta: 144,
        multiplierDelta: toMultiplier - fromMultiplier,
        percentageChange: `${Number((((toMultiplier - fromMultiplier) / fromMultiplier) * 100).toFixed(2))}%`,
        timeSpanDays: 1,
      },
    };
    const paidDiff = async (
      args: Record<string, unknown>,
      invokedName = "stratigraphy.get_diff",
      assertAliasScope = false,
    ) => {
      const params = { name: invokedName, arguments: args };
      const challenge = await mcpRequestAt(diffBase, "tools/call", params);
      assert.equal(challenge.response.status, 402);
      const offer = challenge.body as unknown as { amount_sats: number; macaroon: string; payment_hash: string };
      assert.equal(offer.amount_sats, 250);
      const verified = verifySubscriptionMacaroon(
        offer.macaroon, "contract-mcp-secret", Math.floor(Date.now() / 1000),
      );
      assert.ok(verified);
      assert.deepEqual(verified.allowedPaths, [`/mcp/tools/${invokedName}`]);
      const payment = mcpInvoices.get(offer.payment_hash);
      assert.ok(payment);
      if (assertAliasScope) {
        const otherName = invokedName === "stratigraphy.get_diff"
          ? "stratigraphy.diff"
          : "stratigraphy.get_diff";
        const bypass = await mcpRequestAt(
          diffBase, "tools/call", { name: otherName, arguments: args }, undefined,
          `L402 ${offer.macaroon}:${payment.preimage}`,
        );
        assert.equal(bypass.response.status, 402);
        assert.notEqual((bypass.body as { payment_hash?: string }).payment_hash, offer.payment_hash);
      }
      const paid = await mcpRequestAt(diffBase, "tools/call", params, undefined,
        `L402 ${offer.macaroon}:${payment.preimage}`);
      assert.equal(paid.response.status, 200);
      assert.deepEqual(paid.body.result?.content.map((item: { type: string }) => item.type), ["text"]);
      const result = JSON.parse(paid.body.result?.content[0].text);
      assert.deepEqual(paid.body.result?.structuredContent, result);
      return result;
    };
    assert.deepEqual(
      await paidDiff({ fromTarget: "919856" }, "stratigraphy.get_diff", true),
      expected,
    );
    assert.deepEqual(
      await paidDiff({ fromTarget: "919856" }, "stratigraphy.diff", true),
      expected,
      "legacy and canonical diff calls must both be functional at the same price",
    );
    assert.deepEqual(await paidDiff({ fromTarget: "919856" }), expected);
    assert.deepEqual(await paidDiff({ fromTarget: "2026-09-08", toTarget: "2026-09-09" }), expected);
    const reverse = await paidDiff({ fromTarget: "920000", toTarget: "919856" });
    assert.deepEqual(reverse, {
      from: expected.to,
      to: expected.from,
      delta: {
        heightDelta: -144,
        multiplierDelta: fromMultiplier - toMultiplier,
        percentageChange: `${Number((((fromMultiplier - toMultiplier) / toMultiplier) * 100).toFixed(2))}%`,
        timeSpanDays: -1,
      },
    });
    const same = await paidDiff({ fromTarget: "920000", toTarget: "2026-09-09" });
    assert.deepEqual(same.delta, {
      heightDelta: 0, multiplierDelta: 0, percentageChange: "0%", timeSpanDays: 0,
    });
    for (const args of [
      {},
      { fromTarget: "2026-02-30" },
      { fromTarget: "919856", toTarget: "2026-09-27" },
      { fromTarget: "919857" },
    ]) {
      const invoiceCount = mcpInvoiceCount;
      const invalid = await mcpRequestAt(diffBase, "tools/call", {
        name: "stratigraphy.get_diff", arguments: args,
      });
      assert.ok([200, 400].includes(invalid.response.status));
      assert.equal(invalid.body.error?.code, -32602);
      assert.equal(invalid.response.headers.get("www-authenticate"), null);
      assert.equal(mcpInvoiceCount, invoiceCount);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      diffServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("returns a bounded sequential range for one 250-sat MCP payment", async () => {
  const rangeApp = express();
  rangeApp.use(express.json());
  registerMcpRoute(rangeApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-secret",
    revocationStore: createMemoryMacaroonRevocationStore(),
  });
  const rangeServer = rangeApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => rangeServer.once("listening", resolve));
  const rangeBase = `http://127.0.0.1:${(rangeServer.address() as AddressInfo).port}`;
  try {
    const tools = (await mcpRequestAt(rangeBase, "tools/list")).body.result?.tools;
    const tool = tools.find((candidate: { name: string }) => candidate.name === "stratigraphy.get_range");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["startTarget"]);
    assert.equal(tool.inputSchema.properties.endTarget.default, "latest");
    assert.equal(tool.inputSchema.properties.limit.default, 50);
    assert.equal(tool.inputSchema.properties.limit.maximum, 100);
    assert.equal(tool.inputSchema.properties.format.default, "compact");
    assert.deepEqual(tool.inputSchema.properties.format.enum, ["compact", "minimal", "kv"]);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.idempotentHint, true);

    const dataset = await readDataset();
    const fingerprint = (record: typeof dataset[number]) => createHash("sha256").update(JSON.stringify([
      record.day, record.title, record.video_id, record.transcript_summary,
      record.quantitative_alpha.target_multiplier,
      record.quantitative_alpha.difficulty_epoch_progress,
      record.quantitative_alpha.thermodynamic_signal,
    ])).digest("hex");
    const expectedItem = (offset: number, format: "compact" | "minimal" | "kv") => {
      const record = dataset.at(offset)!;
      const height = 920000 + (offset + 1) * 144;
      const date = new Date(Date.UTC(2026, 8, 9) +
        (offset + 1) * 86_400_000)
        .toISOString().slice(0, 10);
      const tm = record.quantitative_alpha.target_multiplier;
      const hash = fingerprint(record);
      if (format === "minimal") return [height, date, tm, hash];
      if (format === "kv") return { h: height, ts: date, tm, hash };
      return `HEIGHT:${height}|DATE:${date}|TM:${tm}|HASH:${hash}`;
    };
    const paidRange = async (
      args: Record<string, unknown>,
      invokedName = "stratigraphy.get_range",
      assertAliasScope = false,
    ) => {
      const params = { name: invokedName, arguments: args };
      const challenge = await mcpRequestAt(rangeBase, "tools/call", params);
      assert.equal(challenge.response.status, 402);
      const offer = challenge.body as unknown as { amount_sats: number; macaroon: string; payment_hash: string };
      assert.equal(offer.amount_sats, 250);
      const verified = verifySubscriptionMacaroon(
        offer.macaroon, "contract-mcp-secret", Math.floor(Date.now() / 1000),
      );
      assert.ok(verified);
      assert.deepEqual(verified.allowedPaths, [`/mcp/tools/${invokedName}`]);
      const payment = mcpInvoices.get(offer.payment_hash);
      assert.ok(payment);
      if (assertAliasScope) {
        const otherName = invokedName === "stratigraphy.get_range"
          ? "stratigraphy.range"
          : "stratigraphy.get_range";
        const bypass = await mcpRequestAt(
          rangeBase, "tools/call", { name: otherName, arguments: args }, undefined,
          `L402 ${offer.macaroon}:${payment.preimage}`,
        );
        assert.equal(bypass.response.status, 402);
        assert.notEqual((bypass.body as { payment_hash?: string }).payment_hash, offer.payment_hash);
      }
      const paid = await mcpRequestAt(rangeBase, "tools/call", params, undefined,
        `L402 ${offer.macaroon}:${payment.preimage}`);
      assert.equal(paid.response.status, 200);
      assert.deepEqual(paid.body.result?.content.map((item: { type: string }) => item.type), ["text"]);
      const result = JSON.parse(paid.body.result?.content[0].text);
      assert.deepEqual(paid.body.result?.structuredContent, result);
      return result;
    };
    const sampleRangeArgs = { startTarget: "919712" };
    const canonicalRange = await paidRange(
      sampleRangeArgs, "stratigraphy.get_range", true,
    );
    const legacyRange = await paidRange(
      sampleRangeArgs, "stratigraphy.range", true,
    );
    assert.deepEqual(
      legacyRange,
      canonicalRange,
      "legacy and canonical range calls must both be functional at the same price",
    );
    assert.deepEqual(await paidRange({ startTarget: "919712" }), {
      range: { start: "919712", end: "latest" },
      count: 3, format: "compact",
      records: [-3, -2, -1].map((index) => expectedItem(index, "compact")),
    });
    assert.deepEqual(await paidRange({
      startTarget: "919712", endTarget: "2026-09-08", limit: 1, format: "minimal",
    }), {
      range: { start: "919712", end: "2026-09-08" },
      count: 1, format: "minimal",
      records: [expectedItem(-3, "minimal")],
    });
    assert.deepEqual(await paidRange({
      startTarget: "2026-09-08", endTarget: "920000", format: "kv",
    }), {
      range: { start: "2026-09-08", end: "920000" },
      count: 2, format: "kv",
      records: [expectedItem(-2, "kv"), expectedItem(-1, "kv")],
    });
    const oldest = String(920000 - (dataset.length - 1) * 144);
    const defaultLimit = await paidRange({ startTarget: oldest });
    assert.equal(defaultLimit.count, 50);
    assert.equal(defaultLimit.records.length, 50);
    const maxLimit = await paidRange({ startTarget: oldest, limit: 100 });
    assert.equal(maxLimit.count, 100);
    assert.equal(maxLimit.records.length, 100);
    for (const args of [
      {}, { startTarget: "2026-02-30" }, { startTarget: "919857" },
      { startTarget: "920000", endTarget: "919856" },
      { startTarget: "919856", endTarget: "2026-09-27" },
      { startTarget: "919856", limit: 101 },
      { startTarget: "919856", limit: 0 },
      { startTarget: "919856", limit: 1.5 },
      { startTarget: "919856", format: "raw" },
    ]) {
      const invoiceCount = mcpInvoiceCount;
      const invalid = await mcpRequestAt(rangeBase, "tools/call", {
        name: "stratigraphy.get_range", arguments: args,
      });
      assert.ok([200, 400].includes(invalid.response.status));
      assert.equal(invalid.body.error?.code, -32602);
      assert.equal(invalid.response.headers.get("www-authenticate"), null);
      assert.equal(mcpInvoiceCount, invoiceCount);
    }
    const params = {
      name: "stratigraphy.get_range",
      arguments: { startTarget: "919856", endTarget: "latest" },
    };
    const challenge = await mcpRequestAt(rangeBase, "tools/call", params);
    assert.equal(challenge.response.status, 402);
    const offer = challenge.body as unknown as { macaroon: string; payment_hash: string };
    const payment = mcpInvoices.get(offer.payment_hash);
    assert.ok(payment);
    const bounded = attenuateSubscriptionMacaroon(offer.macaroon, ["max_target=919856"]);
    assert.ok(bounded);
    const forbidden = await mcpRequestAt(rangeBase, "tools/call", params, undefined,
      `L402 ${bounded}:${payment.preimage}`);
    assert.equal(forbidden.response.status, 403);
    const permitted = await mcpRequestAt(rangeBase, "tools/call", {
      name: "stratigraphy.get_range",
      arguments: { startTarget: "919856", endTarget: "919856" },
    }, undefined, `L402 ${bounded}:${payment.preimage}`);
    assert.equal(permitted.response.status, 200);
    assert.equal(JSON.parse(permitted.body.result?.content[0].text).count, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      rangeServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("derives authentic caveated MCP sub-tokens and enforces inherited restrictions", async () => {
  const revocationStore = createMemoryMacaroonRevocationStore();
  const attenuationApp = express();
  attenuationApp.use(express.json());
  registerMcpRoute(attenuationApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-secret",
    revocationStore,
  });
  const attenuationServer = attenuationApp.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => attenuationServer.once("listening", resolve));
  const attenuationBase = `http://127.0.0.1:${(attenuationServer.address() as AddressInfo).port}`;
  try {
    const listed = (await mcpRequestAt(attenuationBase, "tools/list")).body;
    const tool = listed.result?.tools.find(
      (candidate: { name: string }) => candidate.name === "proof.attenuate",
    );
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["macaroon", "caveats"]);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.idempotentHint, true);

    const digestArgs = { name: "stratigraphy.digest", arguments: { target: "2026-09-09" } };
    const challenge = await mcpRequestAt(attenuationBase, "tools/call", digestArgs);
    assert.equal(challenge.response.status, 402);
    const offer = challenge.body as unknown as { macaroon: string; payment_hash: string };
    const payment = mcpInvoices.get(offer.payment_hash);
    assert.ok(payment);
    const cutoff = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const call = async (args: Record<string, unknown>) =>
      mcpRequestAt(attenuationBase, "tools/call", {
        name: "proof.attenuate", arguments: args,
      });
    const derived = await call({
      macaroon: offer.macaroon,
      caveats: [
        `time_before = ${cutoff}`,
        "max_target = 920000",
        "allowed_tools = stratigraphy.get,stratigraphy.digest",
      ],
      ttlSeconds: 300,
    });
    assert.equal(derived.response.status, 200);
    assert.equal(derived.response.headers.get("cache-control"), "no-store");
    const result = JSON.parse(derived.body.result?.content[0].text);
    assert.deepEqual(derived.body.result?.structuredContent, result);
    assert.equal(result.status, "attenuated");
    assert.equal(new Date(result.issuedAt).toISOString(), result.issuedAt);
    assert.deepEqual(result.appliedCaveats.slice(0, 3), [
      `time_before=${cutoff}`,
      "max_target=920000",
      "allowed_tools=stratigraphy.get,stratigraphy.digest",
    ]);
    assert.match(result.appliedCaveats[3], /^time_before=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const verified = verifySubscriptionMacaroon(
      result.attenuatedMacaroon,
      "contract-mcp-secret",
      Math.floor(Date.now() / 1000),
    );
    assert.ok(verified);
    assert.deepEqual(verified.allowedPaths, ["/mcp/tools/stratigraphy.digest"]);
    assert.deepEqual(verified.allowedToolSets, [["stratigraphy.get", "stratigraphy.digest"]]);
    assert.equal(verified.maxTarget, 920000);
    assert.equal(verified.maxRequests, 1);
    assert.equal(verifySubscriptionMacaroon(
      result.attenuatedMacaroon, "contract-mcp-secret",
      Math.floor(Date.now() / 1000) + 301,
    ), null);
    const wrongTool = await mcpRequestAt(
      attenuationBase, "tools/call",
      { name: "stratigraphy.diff", arguments: { fromTarget: "919856" } },
      undefined,
      `L402 ${result.attenuatedMacaroon}:${payment.preimage}`,
    );
    assert.equal(wrongTool.response.status, 403);
    const paid = await mcpRequestAt(
      attenuationBase, "tools/call", digestArgs, undefined,
      `L402 ${result.attenuatedMacaroon}:${payment.preimage}`,
    );
    assert.equal(paid.response.status, 200);
    assert.match(paid.body.result?.content[0].text, /HEIGHT:920000/);

    const another = await mcpRequestAt(attenuationBase, "tools/call", digestArgs);
    const secondOffer = another.body as unknown as { macaroon: string; payment_hash: string };
    const secondPayment = mcpInvoices.get(secondOffer.payment_hash);
    assert.ok(secondPayment);
    const bounded = await call({
      macaroon: secondOffer.macaroon, caveats: ["max_target = 919856"],
    });
    assert.equal(bounded.response.status, 200);
    const boundedToken = bounded.body.result?.structuredContent.attenuatedMacaroon;
    const blocked = await mcpRequestAt(
      attenuationBase, "tools/call", digestArgs, undefined,
      `L402 ${boundedToken}:${secondPayment.preimage}`,
    );
    assert.equal(blocked.response.status, 403);
    const invalid = await call({ macaroon: "not-a-macaroon", caveats: ["max_target = 870000"] });
    assert.equal(invalid.response.status, 401);
    const ignored = await call({ macaroon: secondOffer.macaroon, caveats: ["unsupported = anything"] });
    assert.equal(ignored.response.status, 400);
    await revocationStore.revoke(getMacaroonSignatureId(secondOffer.macaroon)!);
    const revoked = await call({ macaroon: secondOffer.macaroon, caveats: ["max_target = 870000"] });
    assert.equal(revoked.response.status, 401);
    const revokedUse = await mcpRequestAt(
      attenuationBase, "tools/call", digestArgs, undefined,
      `L402 ${secondOffer.macaroon}:${secondPayment.preimage}`,
    );
    assert.equal(revokedUse.response.status, 401);

    const restParent = createSubscriptionMacaroon({
      secret: process.env.SESSION_SECRET!,
      paymentHash,
      tier: "1-day",
      validUntil: Math.floor(Date.now() / 1000) + 3600,
      amountMsats: 5_000,
      paymentProvider: "contract-mcp",
    });
    for (const caveat of ["allowed_tools=stratigraphy.get", "max_target=0"]) {
      const restChild = attenuateSubscriptionMacaroon(restParent, [caveat]);
      assert.ok(restChild);
      const deniedRest = await fetch(`${baseUrl}/api/v1/stratigraphy/l402`, {
        headers: { Authorization: `L402 ${restChild}:${preimage}` },
      });
      assert.equal(deniedRest.status, 403, `${caveat} must not be ignored by REST L402`);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      attenuationServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("broadcasts a freshly signed canonical snapshot and requires a peer acknowledgment", async () => {
  const args = {
    name: "mesh.broadcast",
    arguments: { signalType: "telemetry_snapshot", payload: { date: "2026-09-09" } },
  };
  const beforeInvoiceCount = mcpInvoiceCount;
  const unavailable = await mcpRequestAt(baseUrl, "tools/call", args);
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.body.error?.code, -32603);
  assert.equal(mcpInvoiceCount, beforeInvoiceCount, "no configured peers must not create an invoice");

  const signedSnapshots: unknown[] = [];
  let acknowledge = true;
  const localAttestation = {
    pubkey: "ab".repeat(32), signature: "cd".repeat(32), eventId: "ef".repeat(32),
    createdAt: Math.floor(Date.now() / 1_000), roundTripLatencyMs: 0,
  };
  const peerAttestation = {
    ...localAttestation, pubkey: "12".repeat(32), eventId: "34".repeat(32), roundTripLatencyMs: 3,
  };
  const broadcastApp = express();
  broadcastApp.set("trust proxy", 1);
  broadcastApp.use(express.json());
  broadcastApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerMcpRoute(broadcastApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-broadcast-secret",
    meshService: {
      status: () => ({
        nodePubkey: localAttestation.pubkey,
        activePeerCount: 1,
        configuredPeerCount: 1,
        topologyHealth: "degraded",
        crossValidationSuccessRate: 0,
        averagePropagationLatencyMs: 0,
        quorumThreshold: 2,
      }),
      createConsensus: async (snapshot) => {
        signedSnapshots.push(snapshot);
        return {
          quorumScore: acknowledge ? 1 : 0.5,
          peerAttestations: acknowledge
            ? [localAttestation, peerAttestation]
            : [localAttestation],
          merkleRoot: "56".repeat(32),
          snapshotDigest: "78".repeat(32),
          threshold: 2,
          isolationMode: false,
          networkId: "bitcoin-stratigraphy-mainnet-v1",
        };
      },
    },
  });
  const broadcastServer = broadcastApp.listen(0);
  await new Promise<void>((resolve) => broadcastServer.once("listening", resolve));
  const address = broadcastServer.address() as AddressInfo;
  const broadcastUrl = `http://127.0.0.1:${address.port}`;
  const paidCall = async () => {
    const challenge = await mcpRequestAt(broadcastUrl, "tools/call", args);
    assert.equal(challenge.response.status, 402);
    const issued = challenge.body as unknown as { macaroon: string; payment_hash: string; amount_sats: number };
    assert.equal(issued.amount_sats, 250);
    const payment = mcpInvoices.get(issued.payment_hash);
    assert.ok(payment);
    return mcpRequestAt(
      broadcastUrl, "tools/call", args, undefined,
      `L402 ${issued.macaroon}:${payment.preimage}`,
    );
  };
  try {
    const { response, body } = await paidCall();
    assert.equal(response.status, 200);
    assert.deepEqual(body.result?.structuredContent, {
      signalType: "telemetry_snapshot",
      date: "2026-09-09",
      snapshotDigest: "78".repeat(32),
      peerAttestations: 1,
      quorumThreshold: 2,
      merkleRoot: "56".repeat(32),
      networkId: "bitcoin-stratigraphy-mainnet-v1",
    });
    assert.equal(signedSnapshots.length, 1);
    const signed = signedSnapshots[0] as {
      day: number;
      attestation: { event: Parameters<typeof verifyEvent>[0] };
    };
    assert.equal(signed.day, 422);
    assert.equal(verifyEvent(signed.attestation.event), true);

    acknowledge = false;
    const unacknowledged = await paidCall();
    assert.equal(unacknowledged.body.error?.code, -32603);
    assert.match(unacknowledged.body.error?.message ?? "", /No mesh peer acknowledged/);
  } finally {
    broadcastServer.close();
  }
});

test("returns JSON-RPC -32602 for invalid arguments to every MCP tool", async () => {
  const invalidApp = express();
  invalidApp.set("trust proxy", 1);
  invalidApp.use(express.json());
  invalidApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerMcpRoute(invalidApp, {
    settlementRouter: mcpSettlementRouter,
    sessionSecret: "contract-mcp-secret",
  });
  const invalidServer = invalidApp.listen(0);
  await new Promise<void>((resolve) => invalidServer.once("listening", resolve));
  const address = invalidServer.address() as AddressInfo;
  const invalidBaseUrl = `http://127.0.0.1:${address.port}`;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["stratigraphy.get", { days: 0 }],
    ["stratigraphy.list", { unexpected: true }],
    ["proof.verify", {}],
    ["proof.status", { proofHash: "<script>alert(1)</script>" }],
    ["proof.get_by_hash", { hash: "not-a-hash-or-cid" }],
    ["proof.get_by_hash", {}],
    ["proof.list", { limit: 0 }],
    ["proof.submit", {
      proof: {
        pi_a: ["1", "2", "1"],
        pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
        pi_c: ["5", "6", "1"],
      },
      publicSignals: ["920000", "1", "1789776000000", "12583", "1"],
      snapshotDigest: "2",
    }],
    ["proof.ground", { contextHash: "not-hex", agentId: "agent" }],
    ["proof.epistemic_receipt", { cid: "not-a-cid" }],
    ["mesh.status", { unexpected: true }],
    ["mesh.broadcast", { signalType: "telemetry_snapshot", payload: { date: "not-a-date" } }],
  ];

  try {
    for (const [name, args] of cases) {
      const { response, body } = await mcpRequestAt(
        invalidBaseUrl,
        "tools/call",
        { name, arguments: args },
      );
      assert.equal(response.status, 200, name);
      assert.equal(body.error?.code, -32602, `${name}: ${JSON.stringify(body)}`);
    }

    const catalog = await mcpRequestAt(invalidBaseUrl, "tools/call", {
      name: "stratigraphy.list", arguments: {},
    });
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.response.headers.has("www-authenticate"), false);
    assert.ok(catalog.body.result?.structuredContent);
    const mesh = await mcpRequestAt(invalidBaseUrl, "tools/call", {
      name: "mesh.status", arguments: {},
    });
    assert.equal(mesh.response.status, 200);
    assert.equal(mesh.response.headers.has("www-authenticate"), false);
    assert.ok(mesh.body.result?.structuredContent);
    const listed = await mcpRequestAt(invalidBaseUrl, "tools/list");
    assert.equal(listed.response.headers.has("www-authenticate"), false);
    assert.ok(listed.body.result?.tools?.length);
  } finally {
    invalidServer.close();
  }
});

test("enforces independent 60-per-minute per-IP limits for MCP and REST", async () => {
  const mcpRateApp = express();
  mcpRateApp.set("trust proxy", 1);
  mcpRateApp.use(express.json());
  mcpRateApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerMcpRoute(mcpRateApp);
  const mcpRateServer = mcpRateApp.listen(0);

  const restRateApp = express();
  restRateApp.set("trust proxy", 1);
  const restMiddleware = createHttpRateLimitMiddleware(
    createSlidingWindowRateLimiter({ limit: 60, windowMs: 60_000 }),
  );
  restRateApp.get("/limited", restMiddleware, (_req, res) => {
    res.json({ ok: true });
  });
  restRateApp.get("/public", (_req, res) => {
    res.json({ ok: true });
  });
  const restRateServer = restRateApp.listen(0);

  await Promise.all([
    new Promise<void>((resolve) => mcpRateServer.once("listening", resolve)),
    new Promise<void>((resolve) => restRateServer.once("listening", resolve)),
  ]);
  const mcpAddress = mcpRateServer.address() as AddressInfo;
  const restAddress = restRateServer.address() as AddressInfo;
  const mcpRateBaseUrl = `http://127.0.0.1:${mcpAddress.port}`;
  const restRateBaseUrl = `http://127.0.0.1:${restAddress.port}`;

  try {
    for (let index = 0; index < 60; index += 1) {
      const { response } = await mcpRequestAt(
        mcpRateBaseUrl,
        "tools/list",
        undefined,
        "198.51.100.10",
      );
      assert.equal(response.status, 200, `MCP request ${index + 1}`);
    }
    const mcpLimited = await mcpRequestAt(
      mcpRateBaseUrl,
      "tools/list",
      undefined,
      "198.51.100.10",
    );
    assert.equal(mcpLimited.response.status, 429);
    assert.equal(mcpLimited.response.headers.get("retry-after"), "60");
    assert.deepEqual(mcpLimited.body, {
      error: "Too many requests",
      code: "rate_limit_exceeded",
      retry_after: 60,
    });
    assert.equal(
      (await mcpRequestAt(
        mcpRateBaseUrl,
        "tools/list",
        undefined,
        "198.51.100.11",
      )).response.status,
      200,
    );

    for (let index = 0; index < 60; index += 1) {
      const response = await fetch(`${restRateBaseUrl}/limited`, {
        headers: { "X-Forwarded-For": "203.0.113.10" },
      });
      assert.equal(response.status, 200, `REST request ${index + 1}`);
    }
    const restLimited = await fetch(`${restRateBaseUrl}/limited`, {
      headers: { "X-Forwarded-For": "203.0.113.10" },
    });
    assert.equal(restLimited.status, 429);
    assert.deepEqual(await restLimited.json(), {
      error: "Too many requests",
      code: "rate_limit_exceeded",
      retry_after: 60,
    });
    assert.equal(
      (await fetch(`${restRateBaseUrl}/limited`, {
        headers: { "X-Forwarded-For": "203.0.113.11" },
      })).status,
      200,
    );
    for (let index = 0; index < 61; index += 1) {
      assert.equal((await fetch(`${restRateBaseUrl}/public`)).status, 200);
    }
  } finally {
    mcpRateServer.close();
    restRateServer.close();
  }
});

test("settles and verifies a paid epistemic grounding receipt", async () => {
  const previousTransaction = transaction;
  transaction = {
    ...validTransaction,
    amount: 5_000,
    description: "Bitcoin Stratigraphy epistemic context grounding",
    settled_at: Math.floor(Date.now() / 1_000),
  };
  const requestBody = {
    contextHash: "CD".repeat(32),
    agentId: "  contract-grounding-agent  ",
    metadata: { purpose: "paid-route-integration" },
  };
  try {
    const challenge = await fetch(`${baseUrl}/api/v1/zk/ground`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(challenge.status, 402);
    const challengeBody = await challenge.json() as {
      amount_sats: number;
      payment_hash: string;
      macaroon: string;
    };
    assert.equal(challengeBody.amount_sats, 5);
    assert.equal(challengeBody.payment_hash, paymentHash);

    const paid = await fetch(`${baseUrl}/api/v1/zk/ground`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `L402 ${challengeBody.macaroon}:${preimage}`,
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(paid.status, 200);
    const paidBody = await paid.json() as {
      receipt: Record<string, unknown> & {
        contextHash: string;
        agentId: string;
        blockHeight: number;
        blockHash: string;
      };
    };
    assert.equal(paidBody.receipt.contextHash, "cd".repeat(32));
    assert.equal(paidBody.receipt.agentId, "contract-grounding-agent");
    assert.equal(paidBody.receipt.blockHeight, 920001);
    assert.equal(paidBody.receipt.blockHash, "ab".repeat(32));

    const verified = await fetch(`${baseUrl}/api/v1/zk/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attestation: paidBody.receipt }),
    });
    assert.equal(verified.status, 200);
    assert.equal(((await verified.json()) as { valid: boolean }).valid, true);

    const tampered = await fetch(`${baseUrl}/api/v1/zk/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attestation: {
          ...paidBody.receipt,
          blockHeight: paidBody.receipt.blockHeight + 1,
        },
      }),
    });
    assert.equal(tampered.status, 200);
    assert.equal(((await tampered.json()) as { valid: boolean }).valid, false);

    const ledgerEntries = await groundingLedger.getRecent(100);
    assert.ok(
      ledgerEntries.some(
        (entry) =>
          entry.channel === "L402" &&
          entry.requestKind === "zk-proof" &&
          entry.satsReceived === 5,
      ),
      "grounding settlement must be recorded as 5 sats in the revenue ledger",
    );
  } finally {
    transaction = previousTransaction;
  }
});

test("reserves epistemic anchor signing for the grounding route", async () => {
  const response = await fetch(`${baseUrl}/api/v1/zk/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: {
        schema: "bitcoin-stratigraphy/epistemic-anchor/v1",
        contextHash: "ab".repeat(32),
        agentId: "forgery-attempt",
        bitcoin: {
          blockHeight: 1,
          blockHash: "cd".repeat(32),
          source: "caller-controlled",
        },
        timestamp: Date.now(),
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.has("www-authenticate"), false);
  assert.deepEqual(await response.json(), {
    error: "Epistemic anchor payloads must use POST /api/v1/zk/ground",
  });
});

test("serves MCP health, explicit CORS preflight, and JSON POST responses", async () => {
  for (const headers of [{}, { Accept: "application/json" }]) {
    const health = await fetch(`${baseUrl}/mcp`, { headers });
    assert.equal(health.status, 200);
    assert.match(health.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.deepEqual(await health.json(), { status: "ok", service: "MCP Server" });
  }

  const preflight = await fetch(`${baseUrl}/mcp`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://glama.ai",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type, Authorization, mcp-session-id",
    },
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "*, Authorization");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);

  const otherPreflight = await fetch(`${baseUrl}/api/healthz`, {
    method: "OPTIONS",
    headers: { Origin: "https://glama.ai", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(otherPreflight.status, 200);
  assert.equal(otherPreflight.headers.get("access-control-allow-origin"), "*");

  const list = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Origin: "https://glama.ai",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("access-control-allow-origin"), "*");
  assert.equal(list.headers.get("access-control-allow-credentials"), null);
  assert.match(list.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.ok(Array.isArray((await list.json() as { result: { tools: unknown[] } }).result.tools));

  const jsonOnly = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(jsonOnly.status, 200);
  assert.match(jsonOnly.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.ok(Array.isArray((await jsonOnly.json() as { result: { tools: unknown[] } }).result.tools));

  for (const method of ["GET", "POST"]) {
    const unknown = await fetch(`${baseUrl}/mcp/unknown`, {
      method,
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal((await unknown.json() as { error: { code: number } }).error.code, -32600);
  }

  const malformed = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Origin: "https://glama.ai", "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("access-control-allow-origin"), "*");
  assert.match(malformed.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal((await malformed.json() as { error: { code: number } }).error.code, -32700);
});

test("serves wildcard CORS on success and errors and immediately finishes Smithery preflights", async () => {
  const requestsBefore = invoiceRequestCount;
  const mcpRequestsBefore = mcpInvoiceCount;
  for (const path of ["/mcp", "/.well-known/mcp/server-card.json", "/api/healthz", "/missing-public-route"]) {
    const response = await fetch(baseUrl + path, {
      headers: { Origin: "https://smithery.ai" },
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.headers.get("access-control-allow-origin"), "*", path);
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS", path);
    assert.equal(response.headers.get("access-control-allow-headers"), "*", path);
    assert.equal(response.headers.get("access-control-allow-credentials"), null, path);
    await response.text();
    for (const requestedHeaders of ["Content-Type, MCP-Protocol-Version, MCP-Session-Id", "authorization, Content-Type", ""]) {
      const preflight = await fetch(baseUrl + path, {
        method: "OPTIONS",
        headers: {
          Origin: "https://smithery.ai",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": requestedHeaders,
          "Content-Type": "application/json",
        },
        // Invalid JSON must never reach the body parser during a preflight.
        body: "{",
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(preflight.status, 200, path);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*", path);
      assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS", path);
      assert.equal(preflight.headers.get("access-control-allow-headers"),
        requestedHeaders.includes("authorization") ? "*, Authorization" : "*", path);
      assert.equal(preflight.headers.get("access-control-allow-credentials"), null, path);
      assert.equal(preflight.headers.get("www-authenticate"), null, path);
      assert.equal(await preflight.text(), "", path);
    }
  }
  assert.equal(invoiceRequestCount, requestsBefore);
  assert.equal(mcpInvoiceCount, mcpRequestsBefore);
});

test("finishes MCP GET and HEAD probes even when scanners advertise SSE", async () => {
  const requestsBefore = invoiceRequestCount;
  for (const method of ["GET", "HEAD"]) {
    for (const accept of ["*/*", "application/json", "text/event-stream", "application/json, text/event-stream"]) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method,
        headers: {
          Accept: accept,
          "User-Agent": "SmitheryBot",
          "MCP-Protocol-Version": "2025-03-26",
        },
        // Covers reading the whole body, not just receiving the first headers.
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(response.status, 200, `${method} ${accept}`);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
      assert.equal(response.headers.get("www-authenticate"), null);
      const body = await response.text();
      if (method === "HEAD") {
        assert.equal(body, "");
      } else {
        assert.deepEqual(JSON.parse(body), { status: "ok", service: "MCP Server" });
      }
    }
  }
  assert.equal(invoiceRequestCount, requestsBefore);

  const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  assert.equal(openApiResponse.headers.get("www-authenticate"), null);
});

test("serves the public MCP discovery manifest with wildcard CORS and no payment", async () => {
  const requestsBefore = invoiceRequestCount;
  const cases: Record<string, string>[] = [
    {},
    { Origin: "https://discovery-client.example" },
    { Origin: "https://discovery-client.example", Authorization: "L402 malformed" },
  ];
  for (const headers of cases) {
    const response = await fetch(`${baseUrl}/.well-known/mcp.json`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.deepEqual(await response.json(), mcpDiscoveryManifest);
  }
  assert.equal(invoiceRequestCount, requestsBefore);
  assert.equal(mcpDiscoveryManifest.mcp.capabilities.tools.count, mcpServerCard.capabilities.tools.length);
  assert.deepEqual(mcpDiscoveryManifest.mcp.capabilities.tools.namespaces, Object.keys(MCP_TOOL_GROUPS));
});

test("serves the public MCP server card without an L402 challenge", async () => {
  const requestsBefore = invoiceRequestCount;
  const response = await fetch(
    `${baseUrl}/.well-known/mcp/server-card.json`,
    {
      headers: {
        Authorization: `L402 ${paymentHash}:${preimage}`,
        "User-Agent": "SmitheryBot",
      },
      signal: AbortSignal.timeout(2_000),
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.deepEqual(await response.json(), {
    name: "bitcoin-stratigraphy-mcp",
    displayName: "Bitcoin Stratigraphy Data Engine",
    description: "Provides thermodynamic data, proof verification, and L402 payments.",
    version: "1.0.0",
    url: "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
  });
  const head = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`, {
    method: "HEAD",
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(invoiceRequestCount, requestsBefore);
});

test("serves Smithery verification text at both public root paths", async () => {
  for (const path of [
    "/smithery-verification",
    "/.well-known/smithery-verification",
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain\b/, path);
    assert.equal(response.headers.get("www-authenticate"), null, path);
    assert.equal(
      await response.text(),
      "smithery-verification=f52238c37708d18a60b49b4f0d4d6f946b1d0d954e4f629e837bdb8bb726d591\n" +
      "smithery-verification=58fb\n",
      path,
    );
  }
});

test("serves all public Glama connector discovery routes exactly", async () => {
  for (const path of [
    "/.well-known/mcp/connector.json",
    "/.well-known/glama-mcp-connector.json",
    "/.well-known/glama.json",
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `L402 ${paymentHash}:${preimage}`,
      },
    });

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/json\b/,
    );
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.deepEqual(await response.json(), glamaConnector);
  }
});

test("serves the root OpenAPI document as raw JSON", async () => {
  const response = await fetch(`${baseUrl}/openapi.json`, {
    redirect: "manual",
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/html/);
  assert.deepEqual(await response.json(), openApiDocument);
});

test("quotes batch MCP costs with itemized invoice details and wildcard CORS without invoices", async () => {
  const before = invoiceRequestCount;
  const response = await fetch(`${baseUrl}/api/v1/cost`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://agent.example" },
    body: JSON.stringify({ tools: ["stratigraphy.get_latest", "proof.verify_zk_proof"] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.equal(response.headers.get("www-authenticate"), null);
  const quote = QuoteMcpToolCostsResponse.parse(await response.json());
  assert.equal(quote.protocol, "L402");
  assert.equal(quote.currency, "sats");
  assert.deepEqual(quote.perToolSats, {
    "stratigraphy.get_latest": 250, "proof.verify_zk_proof": 250,
  });
  assert.equal(quote.total_sats, 500);
  assert.deepEqual(quote.items.map((item: { canonical_tool: string }) => item.canonical_tool), [
    "stratigraphy.get", "proof.verify",
  ]);
  for (const item of quote.items) {
    assert.ok(item.invoice_generation);
    assert.equal(item.price_sats, 250);
    assert.equal(item.payment_required, true);
    assert.equal(item.invoice_generation.tool, item.canonical_tool);
    assert.equal(item.invoice_generation.scope_path, `/mcp/tools/${item.canonical_tool}`);
    assert.equal(item.invoice_generation.amount_sats, item.price_sats);
    assert.equal(item.invoice_generation.endpoint, "/mcp");
    assert.equal(item.invoice_generation.expiry_seconds, 3600);
  }
  assert.equal(quote.l402.invoice_generated, false);
  assert.equal(quote.l402.aggregate_invoice_supported, false);
  assert.equal(quote.l402.challenge_status, 402);
  assert.equal(quote.l402.max_requests, 1);
  assert.equal(invoiceRequestCount, before);
});

test("quotes free, reduced-fee and legacy MCP costs without changing paid alias scopes", async () => {
  const before = invoiceRequestCount;
  const response = await fetch(`${baseUrl}/api/v1/cost`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tools: ["payment.get_info", "proof.list", "stratigraphy.digest"] }),
  });
  assert.equal(response.status, 200);
  const quote = QuoteMcpToolCostsResponse.parse(await response.json());
  assert.deepEqual(quote.perToolSats, {
    "payment.get_info": 0, "proof.list": 10, "stratigraphy.digest": 250,
  });
  assert.equal(quote.total_sats, 260);
  assert.equal(quote.items[0].invoice_generation, null);
  assert.equal(quote.items[0].payment_required, false);
  assert.equal(quote.items[2].canonical_tool, "stratigraphy.get_digest");
  assert.ok(quote.items[2].invoice_generation);
  assert.equal(quote.items[2].invoice_generation.tool, "stratigraphy.digest");
  assert.equal(quote.items[2].invoice_generation.scope_path, "/mcp/tools/stratigraphy.digest");
  assert.equal(invoiceRequestCount, before);
});

test("rejects invalid batch cost selections without creating invoices", async () => {
  const before = invoiceRequestCount;
  for (const payload of [
    {}, { tools: [] }, { tools: "proof.verify" }, { tools: [123] },
    { tools: [""] }, { tools: ["unknown"] }, { tools: ["constructor"] },
    { tools: ["__proto__"] }, { tools: ["proof.verify", "proof.verify"] },
    { tools: ["proof.verify"], extra: true }, { tools: ["x".repeat(129)] },
    { tools: Array.from({ length: 33 }, (_, index) => `tool${index}`) },
  ]) {
    const response = await fetch(`${baseUrl}/api/v1/cost`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://agent.example" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
    assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
  }
  assert.equal(invoiceRequestCount, before);
});

test("preserves GET cost metadata and supports single-tool query pricing", async () => {
  const before = invoiceRequestCount;
  const response = await fetch(`${baseUrl}/api/v1/cost?tool=stratigraphy.get_latest`, {
    headers: { Origin: "https://agent.example" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  const quote = await response.json() as McpBatchCostQuote & {
    dataset: { days: number }; access_tiers: unknown[];
  };
  assert.equal(quote.total_sats, 250);
  assert.deepEqual(quote.perToolSats, { "stratigraphy.get_latest": 250 });
  assert.equal(quote.items[0].canonical_tool, "stratigraphy.get");
  assert.equal(quote.dataset.days, 422);
  assert.equal(quote.access_tiers.length, 2);
  for (const query of ["tool=unknown", "tool=", "tool=proof.verify&tool=proof.list"]) {
    const invalid = await fetch(`${baseUrl}/api/v1/cost?${query}`);
    assert.equal(invalid.status, 400);
    assert.equal(typeof (await invalid.json() as { error: unknown }).error, "string");
  }
  assert.equal(invoiceRequestCount, before);
});

test("serves public pre-flight cost and schema metadata", async () => {
  const requestsBefore = invoiceRequestCount;
  const response = await fetch(`${baseUrl}/api/v1/cost`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("www-authenticate"), null);
  const body = await response.json() as {
    access_tiers: Array<{ id: string; price_sats: number }>;
    dataset: { days: number; grows_over_time: boolean };
    mcp_tool: { name: string; parameters: Record<string, unknown> };
    catalog_tool: { name: string; description: string };
    proof_by_hash_tool: { name: string; identifiers: string[] };
    proof_attestations_tool: {
      name: string;
      parameters: Record<string, unknown>;
      exampleResult: { attestations: unknown[]; total: number };
    };
    submit_proof_tool: { name: string; requiredInputs: string[] };
    response_schema: { type: string };
  };
  assert.deepEqual(
    body.access_tiers.map(({ id, price_sats }) => ({ id, price_sats })),
    [
      { id: "1-day", price_sats: 5 },
      { id: "30-day", price_sats: 100 },
    ],
  );
  assert.equal(body.dataset.days, 422);
  assert.equal(body.dataset.grows_over_time, true);
  assert.equal(body.mcp_tool.name, "stratigraphy.get");
  assert.deepEqual(Object.keys(body.mcp_tool.parameters), [
    "days",
    "date",
    "blockHeight",
    "metrics",
    "startDate",
    "endDate",
    "startBlock",
    "endBlock",
    "limit",
  ]);
  assert.equal(body.catalog_tool.name, "stratigraphy.list");
  assert.equal(body.proof_by_hash_tool.name, "proof.get_by_hash");
  assert.deepEqual(body.proof_by_hash_tool.identifiers, ["hash", "jobId"]);
  assert.equal(
    body.proof_attestations_tool.name,
    "proof.list",
  );
  assert.deepEqual(
    Object.keys(body.proof_attestations_tool.parameters),
    ["limit", "status"],
  );
  assert.equal(
    body.proof_attestations_tool.exampleResult.attestations.length,
    1,
  );
  assert.equal(body.submit_proof_tool.name, "proof.submit");
  assert.deepEqual(body.submit_proof_tool.requiredInputs, [
    "proof",
    "publicSignals",
  ]);
  assert.equal(body.response_schema.type, "array");
  assert.equal(invoiceRequestCount, requestsBefore);
});

test("applies NIP-98 agent discounts and binds issued pass caveats", async () => {
  const costUrl = `${baseUrl}/api/v1/cost`;
  const costResponse = await fetch(costUrl, {
    headers: { Authorization: agentAuthorization(vipAgentKey, costUrl) },
  });
  assert.equal(costResponse.status, 200);
  const cost = (await costResponse.json()) as {
    agent: {
      pubkey: string;
      tier: string;
      discount_percent: number;
      rate_limit_multiplier: number;
    };
    access_tiers: Array<{
      id: string;
      price_sats: number;
      original_price_sats: number;
    }>;
  };
  assert.deepEqual(cost.agent, {
    pubkey: vipAgentPubkey,
    tier: "VIP",
    discount_percent: 15,
    rate_limit_multiplier: 2,
  });
  assert.deepEqual(
    cost.access_tiers.find(({ id }) => id === "30-day"),
    {
      id: "30-day",
      duration_days: 30,
      price_sats: 85,
      original_price_sats: 100,
      discount_sats: 15,
      discount_percent: 15,
      base_price_sats: 100,
      max_price_sats: 250,
      multiplier: 1,
    },
  );

  const paidUrl = `${baseUrl}/api/v1/stratigraphy`;
  const challengeResponse = await fetch(paidUrl, {
    headers: { Authorization: agentAuthorization(vipAgentKey, paidUrl) },
  });
  assert.equal(challengeResponse.status, 402);
  const challenge = (await challengeResponse.json()) as {
    passes: Array<{
      tier: string;
      macaroon: string;
      price_sats: number;
      original_price_sats: number;
      agent_tier: string;
    }>;
  };
  const pass = challenge.passes.find(({ tier }) => tier === "30-day");
  assert.ok(pass);
  assert.equal(pass.price_sats, 85);
  assert.equal(pass.original_price_sats, 100);
  assert.equal(pass.agent_tier, "VIP");
  const inspected = verifySubscriptionMacaroon(
    pass.macaroon,
    process.env.SESSION_SECRET!,
    Math.floor(Date.now() / 1_000),
  );
  assert.equal(inspected?.agentPubkey, vipAgentPubkey);
  assert.equal(inspected?.agentTier, "VIP");

  const mismatch = await fetch(paidUrl, {
    headers: {
      Authorization: `L402 ${pass.macaroon}:${preimage}`,
      "X-Nostr-Authorization": agentAuthorization(otherAgentKey, paidUrl),
    },
  });
  assert.equal(mismatch.status, 401);
  assert.deepEqual(await mismatch.json(), {
    error: "Agent identity does not match macaroon caveat",
  });

  transaction = {
    ...validTransaction,
    amount: 85_000,
    description: "Bitcoin Stratigraphy 30-Day Pass",
  };
  try {
    const accepted = await fetch(paidUrl, {
      headers: {
        Authorization: `L402 ${pass.macaroon}:${preimage}`,
        "X-Nostr-Authorization": agentAuthorization(vipAgentKey, paidUrl),
      },
    });
    assert.equal(accepted.status, 200);
    const body = (await accepted.json()) as { data: unknown[] };
    assert.ok(body.data.length > 5);

    const attenuationUrl = `${baseUrl}/api/v1/macaroon/attenuate`;
    const attenuationBody = JSON.stringify({
      macaroon: pass.macaroon,
      caveats: ["max_requests=2"],
    });
    const attenuation = await fetch(attenuationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `L402 ${pass.macaroon}:${preimage}`,
        "X-Nostr-Authorization": agentAuthorization(
          vipAgentKey,
          attenuationUrl,
          "POST",
          attenuationBody,
        ),
      },
      body: attenuationBody,
    });
    assert.equal(attenuation.status, 200);
    const child = (await attenuation.json()) as { macaroon: string };
    assert.ok(
      verifySubscriptionMacaroon(
        child.macaroon,
        process.env.SESSION_SECRET!,
        Math.floor(Date.now() / 1_000),
        createAgentReputationService({
          tiers: { [vipAgentPubkey]: "VIP" },
        }).identityForPubkey(vipAgentPubkey),
      ),
    );
  } finally {
    transaction = validTransaction;
  }
});

test("rejects an empty attenuation request without a server error", async () => {
  const response = await fetch(`${baseUrl}/api/v1/macaroon/attenuate`, {
    method: "POST",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Invalid attenuation request",
  });
});

test("serves bounded high-demand prices in JSON and L402 metadata", async () => {
  let now = 1_800_000_000_000;
  const pricingEngine = createPricingEngine({ now: () => now });
  for (let index = 0; index < 600; index += 1) {
    pricingEngine.recordRequest(now);
  }
  const pricingApp = express();
  const issuedAmounts: number[] = [];
  pricingApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerStratigraphyRoutes(
    pricingApp,
    () => ({
      lookupInvoice: async () => validTransaction as never,
      makeInvoice: async (request) => {
        issuedAmounts.push(request.amount);
        return {
          ...validTransaction,
          amount: request.amount,
          description: request.description,
          invoice: `lnbc${request.amount}dynamic`,
          payment_hash: createHash("sha256")
            .update(`${request.amount}:${request.description}`)
            .digest("hex"),
        } as never;
      },
      close: () => undefined,
    }),
    {
      now: () => now,
      reuseMs: 5 * 60 * 1000,
      limitWindowMs: 60 * 60 * 1000,
      maxInvoicesPerWindow: 100,
      maxCallers: 10_000,
    },
    createMemoryPaymentChallengeStore(),
    undefined,
    undefined,
    pricingEngine,
  );
  const pricingServer = pricingApp.listen(0);
  await new Promise<void>((resolve) =>
    pricingServer.once("listening", resolve),
  );
  const address = pricingServer.address() as AddressInfo;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/cost`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("x-l402-subscription-tiers"),
      "1-day=15, 30-day=250",
    );
    const body = await response.json() as {
      access_tiers: Array<{
        id: string;
        price_sats: number;
        base_price_sats: number;
        max_price_sats: number;
      }>;
      dynamic_pricing: {
        request_velocity_rpm: number;
        calculated_at: string;
      };
    };
    assert.deepEqual(
      body.access_tiers.map(
        ({ id, price_sats, base_price_sats, max_price_sats }) => ({
          id,
          price_sats,
          base_price_sats,
          max_price_sats,
        }),
      ),
      [
        {
          id: "1-day",
          price_sats: 15,
          base_price_sats: 5,
          max_price_sats: 15,
        },
        {
          id: "30-day",
          price_sats: 250,
          base_price_sats: 100,
          max_price_sats: 250,
        },
      ],
    );
    assert.equal(body.dynamic_pricing.request_velocity_rpm, 601);
    assert.equal(
      body.dynamic_pricing.calculated_at,
      new Date(now).toISOString(),
    );
    const challenge = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/stratigraphy?days=1`,
    );
    assert.equal(challenge.status, 402);
    const challengeBody = await challenge.json() as {
      passes: Array<{ price_sats: number; macaroon: string }>;
    };
    assert.deepEqual(
      challengeBody.passes.map(({ price_sats }) => price_sats),
      [15, 250],
    );
    assert.deepEqual(issuedAmounts.sort((a, b) => a - b), [
      5_000,
      15_000,
      250_000,
    ]);
    assert.deepEqual(
      challengeBody.passes.map(({ macaroon }) =>
        verifySubscriptionMacaroon(
          macaroon,
          process.env.SESSION_SECRET!,
          Math.floor(now / 1000),
        )?.amountMsats
      ),
      [15_000, 250_000],
    );
  } finally {
    pricingServer.close();
  }
});

test("binds dynamic payments to their issued quote across later price changes", async () => {
  const now = Date.now();
  let velocity = 600;
  let invoiceSequence = 0;
  const transactions = new Map<
    string,
    Transaction & { preimage: string }
  >();
  const mutablePricingEngine = {
    recordRequest: () => undefined,
    requestVelocity: () => velocity,
    quote: (tier: "1-day" | "30-day", epochProgress: number) =>
      calculateTierCost(tier, epochProgress, velocity),
  };
  const dynamicApp = express();
  dynamicApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerStratigraphyRoutes(
    dynamicApp,
    () => ({
      lookupInvoice: async ({ payment_hash }) =>
        transactions.get(payment_hash!) as never,
      makeInvoice: async (request) => {
        invoiceSequence += 1;
        const invoicePreimage = createHash("sha256")
          .update(`dynamic-preimage:${invoiceSequence}`)
          .digest("hex");
        const invoicePaymentHash = createHash("sha256")
          .update(Buffer.from(invoicePreimage, "hex"))
          .digest("hex");
        const created = {
          type: "incoming" as const,
          state: "settled" as const,
          amount: request.amount,
          description: request.description ?? "",
          payment_hash: invoicePaymentHash,
          preimage: invoicePreimage,
          invoice: `lnbc${request.amount}dynamic${invoiceSequence}`,
          settled_at: Math.floor(now / 1000),
        };
        transactions.set(invoicePaymentHash, created);
        return created as never;
      },
      close: () => undefined,
    }),
    {
      now: () => now,
      reuseMs: 5 * 60 * 1000,
      limitWindowMs: 60 * 60 * 1000,
      maxInvoicesPerWindow: 100,
      maxCallers: 10_000,
    },
    createMemoryPaymentChallengeStore(),
    undefined,
    undefined,
    mutablePricingEngine,
  );
  const dynamicServer = dynamicApp.listen(0);
  await new Promise<void>((resolve) =>
    dynamicServer.once("listening", resolve),
  );
  const address = dynamicServer.address() as AddressInfo;
  const dynamicBaseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const highResponse = await fetch(
      `${dynamicBaseUrl}/api/v1/stratigraphy?days=1`,
    );
    assert.equal(highResponse.status, 402);
    const highChallenge = await highResponse.json() as {
      passes: Array<{
        tier: string;
        price_sats: number;
        payment_hash: string;
        macaroon: string;
      }>;
    };
    const highOneDay = highChallenge.passes.find(
      ({ tier }) => tier === "1-day",
    );
    assert.ok(highOneDay);
    assert.equal(highOneDay.price_sats, 15);

    velocity = 0;
    const baseResponse = await fetch(
      `${dynamicBaseUrl}/api/v1/stratigraphy?days=1`,
    );
    assert.equal(baseResponse.status, 402);
    const baseChallenge = await baseResponse.json() as typeof highChallenge;
    const baseOneDay = baseChallenge.passes.find(
      ({ tier }) => tier === "1-day",
    );
    assert.ok(baseOneDay);
    assert.equal(baseOneDay.price_sats, 5);
    assert.notEqual(baseOneDay.payment_hash, highOneDay.payment_hash);

    const highTransaction = transactions.get(highOneDay.payment_hash);
    assert.ok(highTransaction);
    const paidAtIssuedPrice = await fetch(
      `${dynamicBaseUrl}/api/v1/stratigraphy?days=1`,
      {
        headers: {
          Authorization:
            `L402 ${highOneDay.macaroon}:${highTransaction.preimage}`,
        },
      },
    );
    assert.equal(paidAtIssuedPrice.status, 200);

    transactions.set(highOneDay.payment_hash, {
      ...highTransaction,
      amount: 5_000,
    });
    const wrongAmount = await fetch(
      `${dynamicBaseUrl}/api/v1/stratigraphy?days=1`,
      {
        headers: {
          Authorization:
            `L402 ${highOneDay.macaroon}:${highTransaction.preimage}`,
        },
      },
    );
    assert.equal(wrongAmount.status, 402);

    transactions.set(paymentHash, {
      ...validTransaction,
      amount: 5_000,
      description: "Bitcoin Stratigraphy 1-Day Micro-Pass",
      preimage,
    });
    const legacyMacaroon = createSubscriptionMacaroon({
      secret: process.env.SESSION_SECRET!,
      paymentHash,
      tier: "1-day",
      validUntil: Math.floor(now / 1000) + 3600,
    });
    const legacyPaid = await fetch(
      `${dynamicBaseUrl}/api/v1/stratigraphy?days=1`,
      {
        headers: { Authorization: `L402 ${legacyMacaroon}:${preimage}` },
      },
    );
    assert.equal(legacyPaid.status, 200);
  } finally {
    dynamicServer.close();
  }
});

test("serves public Nostr heartbeat status metadata", async () => {
  const response = await fetch(`${baseUrl}/api/v1/nostr/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("www-authenticate"), null);
  const body = await response.json() as {
    event_id: string | null;
    pubkey: string | null;
    relays: Array<{ relay: string; status: string }>;
  };
  assert.equal(body.event_id, null);
  assert.equal(body.pubkey, null);
  assert.deepEqual(
    body.relays.map(({ relay }) => relay),
    [
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.nostr.band",
    ],
  );
});

test("builds a valid signed parameterized Nostr heartbeat", () => {
  const event = buildHeartbeatEvent(
    generateSecretKey(),
    422,
    1_800_000_000,
    "https://example.com",
  );
  assert.equal(event.kind, 30078);
  assert.ok(event.tags.some((tag) => tag[0] === "d"));
  assert.equal(verifyEvent(event), true);
  const content = JSON.parse(event.content) as {
    status: string;
    dataset_height: number;
    access_tiers: Array<{ price_sats: number }>;
    mcp_endpoint: string;
  };
  assert.equal(content.status, "healthy");
  assert.equal(content.dataset_height, 422);
  assert.deepEqual(
    content.access_tiers.map(({ price_sats }) => price_sats),
    [5, 100],
  );
  assert.equal(content.mcp_endpoint, "https://example.com/mcp");
});

test("serves public HEAD range and cost metadata without an L402 challenge", async () => {
  const requestsBefore = invoiceRequestCount;
  const response = await fetch(`${baseUrl}/api/v1/stratigraphy?days=10`, {
    method: "HEAD",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal(response.headers.get("x-stratigraphy-records"), "10");
  assert.equal(response.headers.get("x-stratigraphy-first-day"), "413");
  assert.equal(response.headers.get("x-stratigraphy-last-day"), "422");
  assert.equal(response.headers.get("x-l402-cost-sats"), "10");
  assert.equal(
    response.headers.get("x-l402-subscription-tiers"),
    "1-day=5, 30-day=100",
  );
  assert.equal(await response.text(), "");
  assert.equal(invoiceRequestCount, requestsBefore);
});

test("rejects invalid public HEAD ranges without creating an invoice", async () => {
  const requestsBefore = invoiceRequestCount;
  const response = await fetch(
    `${baseUrl}/api/v1/stratigraphy?days=5&from=2026-09-01`,
    { method: "HEAD" },
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.equal(await response.text(), "");
  assert.equal(invoiceRequestCount, requestsBefore);
});

test("keeps OpenAPI public while the paid dataset requires L402", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  process.env.NWC_URI = "nostr+walletconnect://configured";
  let makeInvoiceCalls = 0;

  try {
    await withContractServer(
      () => ({
        lookupInvoice: async () => validTransaction as never,
        makeInvoice: async () => {
          makeInvoiceCalls += 1;
          return validTransaction as never;
        },
        close: () => undefined,
      }),
      async (paidUrl, contractBaseUrl) => {
        const openapiResponse = await fetch(
          `${contractBaseUrl}/openapi.json`,
          { redirect: "manual" },
        );
        assert.equal(openapiResponse.status, 200);
        assert.match(
          openapiResponse.headers.get("content-type") ?? "",
          /^application\/json\b/,
        );
        assert.equal(openapiResponse.headers.has("www-authenticate"), false);
        assert.equal(makeInvoiceCalls, 0);
        assert.deepEqual(await openapiResponse.json(), openApiDocument);

        const paidResponse = await fetch(`${paidUrl}?days=1`);
        assert.equal(paidResponse.status, 402);
        assert.match(
          paidResponse.headers.get("www-authenticate") ?? "",
          /^L402 /,
        );
        assert.equal(makeInvoiceCalls, 3);
      },
    );
  } finally {
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
  }
});

test("keeps liveness healthy when payment dependencies are unavailable", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  delete process.env.NWC_URI;
  try {
    const response = await fetch(`${baseUrl}/api/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
  }
});

test("reports public dataset health without creating an L402 challenge", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  const invoicesBeforeRequest = invoiceRequestCount;
  delete process.env.NWC_URI;
  try {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      datasetLength: 422,
      protocol: "L402",
    });
    assert.equal(invoiceRequestCount, invoicesBeforeRequest);
    assert.equal(response.headers.has("www-authenticate"), false);
  } finally {
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
  }
});

test("reports ready when payment dependencies are available", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  process.env.NWC_URI = "nostr+walletconnect://configured";
  try {
    const response = await fetch(`${baseUrl}/api/readyz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      dependencies: {
        wallet_configuration: "available",
        challenge_coordination: "available",
      },
    });
  } finally {
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
  }
});

test("reports not ready when wallet configuration is missing", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  const configuredAlbyNwcUri = process.env.ALBY_NWC_URI;
  const configuredFallbackNwcUri = process.env.NWC_FALLBACK_URI;
  delete process.env.NWC_URI;
  delete process.env.ALBY_NWC_URI;
  delete process.env.NWC_FALLBACK_URI;
  try {
    const response = await fetch(`${baseUrl}/api/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "not_ready",
      dependencies: {
        wallet_configuration: "unavailable",
        challenge_coordination: "available",
      },
    });
  } finally {
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
    if (configuredAlbyNwcUri === undefined) delete process.env.ALBY_NWC_URI;
    else process.env.ALBY_NWC_URI = configuredAlbyNwcUri;
    if (configuredFallbackNwcUri === undefined) {
      delete process.env.NWC_FALLBACK_URI;
    } else process.env.NWC_FALLBACK_URI = configuredFallbackNwcUri;
  }
});

test("reports not ready when challenge coordination is unavailable", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  process.env.NWC_URI = "nostr+walletconnect://configured";
  const unavailableStore: PaymentChallengeStore = {
    checkHealth: async () => {
      throw new Error("database unavailable");
    },
    getOrCreate: async () => {
      throw new Error("database unavailable");
    },
    consume: async () => undefined,
    findByPaymentHash: async () => null,
  };
  const readinessApp = express();
  readinessApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerStratigraphyRoutes(
    readinessApp,
    undefined,
    undefined,
    unavailableStore,
  );
  const readinessServer = readinessApp.listen(0);
  await new Promise<void>((resolve) =>
    readinessServer.once("listening", resolve),
  );

  try {
    const address = readinessServer.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/readyz`,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "not_ready",
      dependencies: {
        wallet_configuration: "available",
        challenge_coordination: "unavailable",
      },
    });
  } finally {
    readinessServer.close();
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
  }
});

test("returns the documented generic 500 when payment is not configured", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  const configuredAlbyNwcUri = process.env.ALBY_NWC_URI;
  const configuredFallbackNwcUri = process.env.NWC_FALLBACK_URI;
  delete process.env.NWC_URI;
  delete process.env.ALBY_NWC_URI;
  delete process.env.NWC_FALLBACK_URI;
  const unconfiguredApp = express();
  registerStratigraphyRoutes(unconfiguredApp);
  const unconfiguredServer = unconfiguredApp.listen(0);
  await new Promise<void>((resolve) =>
    unconfiguredServer.once("listening", resolve),
  );

  try {
    const address = unconfiguredServer.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/stratigraphy`,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "NWC_URI is not configured",
    });
  } finally {
    unconfiguredServer.close();
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
    if (configuredAlbyNwcUri === undefined) delete process.env.ALBY_NWC_URI;
    else process.env.ALBY_NWC_URI = configuredAlbyNwcUri;
    if (configuredFallbackNwcUri === undefined) {
      delete process.env.NWC_FALLBACK_URI;
    } else process.env.NWC_FALLBACK_URI = configuredFallbackNwcUri;
  }
});

test("coalesces concurrent cold-cache requests into one usable challenge", async () => {
  invoiceRequest = undefined;
  invoiceRequestCount = 0;
  let releaseInvoice!: () => void;
  invoiceGate = new Promise<void>((resolve) => {
    releaseInvoice = resolve;
  });
  const responses = await Promise.all(
    Array.from({ length: 10 }, async () => {
      const responsePromise = fetch(`${baseUrl}/api/v1/stratigraphy`);
      return responsePromise;
    }).map(async (responsePromise, index, all) => {
      if (index === all.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(invoiceRequestCount, 1);
        releaseInvoice();
      }
      return responsePromise;
    }),
  );
  invoiceGate = undefined;
  const response = responses[0];

  assert.ok(responses.every((item) => item.status === 402));
  assert.equal(invoiceRequestCount, 3);
  assert.deepEqual(invoiceRequest, {
    amount: 100_000,
    description: "Bitcoin Stratigraphy 30-Day Pass",
    expiry: 3600,
  });
  const authenticate = response.headers.get("www-authenticate") ?? "";
  assert.match(
    authenticate,
    new RegExp(`L402 macaroon="${paymentHash}", invoice="${invoice}"`),
  );
  assert.match(authenticate, /tier="1-day"/);
  assert.match(authenticate, /tier="30-day"/);
  const body = await response.json() as {
    invoice: string;
    payment_hash: string;
    passes: Array<{ tier: string; macaroon: string; valid_until: number }>;
  };
  assert.equal(body.invoice, invoice);
  assert.equal(body.payment_hash, paymentHash);
  assert.deepEqual(body.passes.map((pass) => pass.tier), ["1-day", "30-day"]);
  assert.ok(body.passes.every((pass) => pass.macaroon.length > 64));
});

test("reuses a caller's payment challenge instead of creating more invoices", async () => {
  const requestsBefore = invoiceRequestCount;
  const responses = await Promise.all(
    Array.from({ length: 10 }, () =>
      fetch(`${baseUrl}/api/v1/stratigraphy`),
    ),
  );

  assert.ok(responses.every((response) => response.status === 402));
  assert.equal(invoiceRequestCount, requestsBefore);
  const bodies = (await Promise.all(
    responses.map((response) => response.json()),
  )) as Array<{ invoice: string; payment_hash: string }>;
  assert.ok(
    bodies.every(
      (body) =>
        body.invoice === invoice && body.payment_hash === paymentHash,
    ),
  );
});

test("accepts a paid subscription pass for unlimited queries until expiration", async () => {
  const challengeResponse = await fetch(`${baseUrl}/api/v1/stratigraphy`);
  const challenge = await challengeResponse.json() as {
    passes: Array<{ tier: string; macaroon: string }>;
  };

  try {
    for (const tier of [
      {
        name: "1-day",
        amount: 5_000,
        description: "Bitcoin Stratigraphy 1-Day Micro-Pass",
      },
      {
        name: "30-day",
        amount: 100_000,
        description: "Bitcoin Stratigraphy 30-Day Pass",
      },
    ]) {
      const pass = challenge.passes.find(({ tier: name }) => name === tier.name);
      assert.ok(pass);
      transaction = {
        ...validTransaction,
        amount: tier.amount,
        description: tier.description,
      };
      for (const query of ["days=1", "days=30"]) {
        const response = await fetch(
          `${baseUrl}/api/v1/stratigraphy?${query}`,
          {
            headers: {
              Authorization: `L402 ${pass.macaroon}:${preimage}`,
            },
          },
        );
        assert.equal(response.status, 200);
        await assertValidReceipt(response, paymentHash);
      }
    }
  } finally {
    transaction = validTransaction;
  }
});

test("recursively verifies attenuated caveats and enforces restrictions", async () => {
  const secret = process.env.SESSION_SECRET!;
  const validUntil = Math.floor(Date.now() / 1000) + 3600;
  const master = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil,
  });
  const firstChild = attenuateSubscriptionMacaroon(master, [
    "allowed_path=/api/v1/stratigraphy",
    "max_requests=1",
  ]);
  assert.ok(firstChild);
  const secondChild = attenuateSubscriptionMacaroon(firstChild, [
    "max_requests=5",
  ]);
  assert.ok(secondChild);
  const verified = verifySubscriptionMacaroon(
    secondChild,
    secret,
    Math.floor(Date.now() / 1000),
  );
  assert.ok(verified);
  assert.equal(verified.paymentHash, paymentHash);
  assert.equal(verified.validUntil, validUntil);
  assert.deepEqual(verified.allowedPaths, ["/api/v1/stratigraphy"]);
  assert.equal(verified.maxRequests, 1);

  transaction = {
    ...validTransaction,
    amount: 5_000,
    description: "Bitcoin Stratigraphy 1-Day Micro-Pass",
  };
  try {
    const first = await fetch(`${baseUrl}/api/v1/stratigraphy?days=1`, {
      headers: { Authorization: `L402 ${firstChild}:${preimage}` },
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${baseUrl}/api/v1/stratigraphy?days=1`, {
      headers: { Authorization: `L402 ${secondChild}:${preimage}` },
    });
    assert.equal(second.status, 429);

    const denied = attenuateSubscriptionMacaroon(master, [
      "allowed_path=/api/v1/stratigraphy/today",
    ]);
    assert.ok(denied);
    const deniedResponse = await fetch(`${baseUrl}/api/v1/stratigraphy`, {
      headers: { Authorization: `L402 ${denied}:${preimage}` },
    });
    assert.equal(deniedResponse.status, 403);
  } finally {
    transaction = validTransaction;
  }
});

test("attenuates a paid parent macaroon through the helper route", async () => {
  const challengeResponse = await fetch(`${baseUrl}/api/v1/stratigraphy`);
  const challenge = await challengeResponse.json() as {
    passes: Array<{ tier: string; macaroon: string }>;
  };
  const parent = challenge.passes.find(({ tier }) => tier === "1-day");
  assert.ok(parent);
  transaction = {
    ...validTransaction,
    amount: 5_000,
    description: "Bitcoin Stratigraphy 1-Day Micro-Pass",
  };
  try {
    const response = await fetch(`${baseUrl}/api/v1/macaroon/attenuate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `L402 ${parent.macaroon}:${preimage}`,
      },
      body: JSON.stringify({
        macaroon: parent.macaroon,
        caveats: [
          "allowed_path=/api/v1/stratigraphy",
          "max_requests=2",
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { macaroon: string };
    const child = verifySubscriptionMacaroon(
      body.macaroon,
      process.env.SESSION_SECRET!,
      Math.floor(Date.now() / 1000),
    );
    assert.deepEqual(child?.allowedPaths, ["/api/v1/stratigraphy"]);
    assert.equal(child?.maxRequests, 2);
  } finally {
    transaction = validTransaction;
  }
});

test("revokes a macaroon before payment validation", async () => {
  const macaroon = createSubscriptionMacaroon({
    secret: process.env.SESSION_SECRET!,
    paymentHash,
    tier: "1-day",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
  });
  const unauthorized = await fetch(`${baseUrl}/api/v1/macaroon/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer incorrect-secret",
    },
    body: JSON.stringify({ macaroon }),
  });
  assert.equal(unauthorized.status, 401);

  const revoked = await fetch(`${baseUrl}/api/v1/macaroon/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorSecret}`,
    },
    body: JSON.stringify({ macaroon, reason: "delegated token compromised" }),
  });
  assert.equal(revoked.status, 200);
  const revokedBody = await revoked.json() as {
    signature_id: string;
    revoked_at: string;
    reason: string;
  };
  assert.equal(revokedBody.signature_id, getMacaroonSignatureId(macaroon));
  assert.equal(
    new Date(revokedBody.revoked_at).toISOString(),
    revokedBody.revoked_at,
  );
  assert.equal(revokedBody.reason, "delegated token compromised");

  const lookupsBefore = lookupInvoiceCount;
  const denied = await fetch(`${baseUrl}/api/v1/stratigraphy?days=1`, {
    headers: { Authorization: `L402 ${macaroon}:${preimage}` },
  });
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "Token has been revoked" });
  assert.equal(lookupInvoiceCount, lookupsBefore);

  const attenuationDenied = await fetch(
    `${baseUrl}/api/v1/macaroon/attenuate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `L402 ${macaroon}:${preimage}`,
      },
      body: JSON.stringify({
        macaroon,
        caveats: ["max_requests=1"],
      }),
    },
  );
  assert.equal(attenuationDenied.status, 401);
  assert.deepEqual(await attenuationDenied.json(), {
    error: "Token has been revoked",
  });
  assert.equal(lookupInvoiceCount, lookupsBefore);
});

test("revokes by signature id idempotently", async () => {
  const signatureId = "ab".repeat(32);
  let firstRevokedAt: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/macaroon/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${operatorSecret}`,
      },
      body: JSON.stringify({ signature_id: signatureId }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      signature_id: string;
      revoked_at: string;
    };
    assert.equal(body.signature_id, signatureId);
    assert.equal(new Date(body.revoked_at).toISOString(), body.revoked_at);
    firstRevokedAt ??= body.revoked_at;
    assert.equal(body.revoked_at, firstRevokedAt);
  }
});

test("revokes only the selected final macaroon signature", async () => {
  const secret = process.env.SESSION_SECRET!;
  const parent = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil: Math.floor(Date.now() / 1000) + 7200,
  });
  const revokedChild = attenuateSubscriptionMacaroon(parent, [
    "allowed_path=/api/v1/stratigraphy",
  ]);
  const sibling = attenuateSubscriptionMacaroon(parent, ["max_requests=2"]);
  assert.ok(revokedChild);
  assert.ok(sibling);
  const response = await fetch(`${baseUrl}/api/v1/macaroon/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${operatorSecret}`,
    },
    body: JSON.stringify({ macaroon: revokedChild }),
  });
  assert.equal(response.status, 200);

  transaction = {
    ...validTransaction,
    amount: 5_000,
    description: "Bitcoin Stratigraphy 1-Day Micro-Pass",
  };
  try {
    const revokedResponse = await fetch(
      `${baseUrl}/api/v1/stratigraphy?days=1`,
      {
        headers: { Authorization: `L402 ${revokedChild}:${preimage}` },
      },
    );
    assert.equal(revokedResponse.status, 401);
    for (const macaroon of [sibling, parent]) {
      const allowed = await fetch(`${baseUrl}/api/v1/stratigraphy?days=1`, {
        headers: { Authorization: `L402 ${macaroon}:${preimage}` },
      });
      assert.equal(allowed.status, 200);
    }
  } finally {
    transaction = validTransaction;
  }
});

test("fails closed before payment lookup when revocation storage is unavailable", async () => {
  const secret = process.env.SESSION_SECRET!;
  const macaroon = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
  });
  let paymentLookups = 0;
  const unavailableApp = express();
  unavailableApp.use(express.json());
  unavailableApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerStratigraphyRoutes(
    unavailableApp,
    () => ({
      lookupInvoice: async () => {
        paymentLookups += 1;
        return validTransaction as never;
      },
      makeInvoice: async () => validTransaction as never,
      close: () => undefined,
    }),
    undefined,
    createMemoryPaymentChallengeStore(),
    undefined,
    {
      isRevoked: async () => {
        throw new Error("database unavailable");
      },
      revoke: async () => {
        throw new Error("database unavailable");
      },
    },
  );
  const unavailableServer = unavailableApp.listen(0);
  await new Promise<void>((resolve) =>
    unavailableServer.once("listening", resolve),
  );
  const address = unavailableServer.address() as AddressInfo;
  const unavailableBaseUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const request of [
      {
        url: `${unavailableBaseUrl}/api/v1/stratigraphy`,
        init: {
          headers: { Authorization: `L402 ${macaroon}:${preimage}` },
        },
      },
      {
        url: `${unavailableBaseUrl}/api/v1/macaroon/attenuate`,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `L402 ${macaroon}:${preimage}`,
          },
          body: JSON.stringify({ macaroon, caveats: ["max_requests=1"] }),
        },
      },
    ]) {
      const response = await fetch(request.url, request.init);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "Token revocation service unavailable",
      });
    }
    assert.equal(paymentLookups, 0);
  } finally {
    unavailableServer.close();
  }
});

test("uses parameterized idempotent PostgreSQL revocation queries", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const revokedAt = new Date("2026-09-16T01:00:00.000Z");
  const databasePool = {
    async query<Row>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      if (text.includes("SELECT EXISTS")) {
        return { rows: [{ revoked: true }] as Row[] };
      }
      return {
        rows: [{
          signature_id: "cd".repeat(32),
          revoked_at: revokedAt,
          reason: "compromised",
        }] as Row[],
      };
    },
  };
  const store = createPostgresMacaroonRevocationStore(databasePool);
  const signatureId = "cd".repeat(32);
  assert.equal(await store.isRevoked(signatureId), true);
  const result = await store.revoke(signatureId, "compromised");
  assert.deepEqual(result, {
    signatureId,
    revokedAt,
    reason: "compromised",
  });
  assert.deepEqual(calls[0].values, [signatureId]);
  assert.deepEqual(calls[1].values, [signatureId, "compromised"]);
  assert.match(calls[1].text, /ON CONFLICT \(signature_id\) DO UPDATE/);
});

test("rejects expired or tampered subscription caveats during proof checks", async () => {
  const secret = process.env.SESSION_SECRET ?? "contract-test-secret";
  const configuredSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = secret;
  const now = Date.now();
  const expired = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil: Math.floor(now / 1000) - 1,
  });
  const tampered = `${expired.slice(0, -1)}${expired.endsWith("A") ? "B" : "A"}`;
  const settlementExpired = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil: Math.floor(now / 1000) + 60 * 60,
  });
  let settledAt = Math.floor(now / 1000);
  const passApp = express();
  passApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerStratigraphyRoutes(
    passApp,
    () => ({
      lookupInvoice: async () => ({
        ...validTransaction,
        amount: 5_000,
        description: "Bitcoin Stratigraphy 1-Day Micro-Pass",
        settled_at: settledAt,
      }) as never,
      makeInvoice: async () => validTransaction as never,
      close: () => undefined,
    }),
    {
      now: () => now,
      reuseMs: 60_000,
      limitWindowMs: 60_000,
      maxInvoicesPerWindow: 10,
      maxCallers: 10,
    },
  );
  const passServer = passApp.listen(0);
  await new Promise<void>((resolve) =>
    passServer.once("listening", resolve),
  );

  try {
    const address = passServer.address() as AddressInfo;
    for (const macaroon of [expired, tampered, settlementExpired]) {
      if (macaroon === settlementExpired) {
        settledAt = Math.floor(now / 1000) - 24 * 60 * 60 - 1;
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/stratigraphy`,
        {
          headers: { Authorization: `L402 ${macaroon}:${preimage}` },
        },
      );
      assert.equal(response.status, 402);
    }
  } finally {
    passServer.close();
    if (configuredSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = configuredSecret;
  }
});

test("coordinates challenge reuse across API instances", async () => {
  const sharedStore = createMemoryPaymentChallengeStore();
  let creations = 0;
  const clientFactory = () => ({
    lookupInvoice: async () => validTransaction as never,
    makeInvoice: async () => {
      creations += 1;
      return validTransaction as never;
    },
    close: () => undefined,
  });
  const firstApp = express();
  const secondApp = express();
  registerStratigraphyRoutes(firstApp, clientFactory, undefined, sharedStore);
  registerStratigraphyRoutes(secondApp, clientFactory, undefined, sharedStore);
  const servers = [firstApp.listen(0), secondApp.listen(0)];
  await Promise.all(
    servers.map(
      (item) =>
        new Promise<void>((resolve) => item.once("listening", resolve)),
    ),
  );

  try {
    const responses = await Promise.all(
      servers.map((item) => {
        const address = item.address() as AddressInfo;
        return fetch(
          `http://127.0.0.1:${address.port}/api/v1/stratigraphy`,
        );
      }),
    );
    assert.ok(responses.every((response) => response.status === 402));
    assert.equal(creations, 3);
  } finally {
    servers.forEach((item) => item.close());
  }
});

test("fails closed when shared challenge coordination is unavailable", async () => {
  let creations = 0;
  const unavailableStore: PaymentChallengeStore = {
    checkHealth: async () => {
      throw new Error("database unavailable");
    },
    getOrCreate: async () => {
      throw new Error("database unavailable");
    },
    consume: async () => undefined,
    findByPaymentHash: async () => null,
  };
  const unavailableApp = express();
  unavailableApp.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerStratigraphyRoutes(
    unavailableApp,
    () => ({
      lookupInvoice: async () => validTransaction as never,
      makeInvoice: async () => {
        creations += 1;
        return validTransaction as never;
      },
      close: () => undefined,
    }),
    undefined,
    unavailableStore,
  );
  const unavailableServer = unavailableApp.listen(0);
  await new Promise<void>((resolve) =>
    unavailableServer.once("listening", resolve),
  );

  try {
    const address = unavailableServer.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/stratigraphy`,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Payment challenge service unavailable",
    });
    assert.equal(creations, 0);
  } finally {
    unavailableServer.close();
  }
});

test("the PostgreSQL store coalesces concurrent instance requests", async () => {
  const caller = "contract-postgres-concurrent";
  await pool.query(
    "DELETE FROM payment_range_challenges WHERE caller_key = $1",
    [caller],
  );
  await pool.query("DELETE FROM payment_challenges WHERE caller_key = $1", [
    caller,
  ]);
  const firstStore = createPostgresPaymentChallengeStore();
  const secondStore = createPostgresPaymentChallengeStore();
  let creations = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy = {
    now: Date.now,
    reuseMs: 60_000,
    limitWindowMs: 60_000,
    maxInvoicesPerWindow: 3,
    maxCallers: 10_000,
  };
  const create = async () => {
    creations += 1;
    await gate;
    return { invoice, paymentHash, issuedAt: policy.now() };
  };

  try {
    const first = firstStore.getOrCreate(caller, "full", policy, create);
    const second = secondStore.getOrCreate(caller, "full", policy, create);
    const deadline = Date.now() + 2_000;
    while (creations === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(creations, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result.kind === "challenge"));
    assert.equal(creations, 1);

    const secondRange = await firstStore.getOrCreate(
      caller,
      "days-10",
      policy,
      create,
    );
    assert.equal(secondRange.kind, "challenge");
    assert.equal(creations, 2);
    const reusedFirstRange = await secondStore.getOrCreate(
      caller,
      "full",
      policy,
      create,
    );
    assert.equal(reusedFirstRange.kind, "challenge");
    assert.equal(creations, 2);

    await firstStore.consume(caller, "full", paymentHash);
    const recreatedFirstRange = await firstStore.getOrCreate(
      caller,
      "full",
      policy,
      create,
    );
    assert.equal(recreatedFirstRange.kind, "challenge");
    assert.equal(creations, 3);
    await firstStore.consume(caller, "days-10", paymentHash);
    const stillLimited = await secondStore.getOrCreate(
      caller,
      "days-10",
      policy,
      create,
    );
    assert.equal(stillLimited.kind, "limited");
    assert.equal(creations, 3);
  } finally {
    release();
    await pool.query(
      "DELETE FROM payment_range_challenges WHERE caller_key = $1",
      [caller],
    );
    await pool.query(
      "DELETE FROM payment_challenges WHERE caller_key = $1",
      [caller],
    );
  }
});

test("failed PostgreSQL invoice creations consume shared quota", async () => {
  const caller = "contract-postgres-failures";
  await pool.query(
    "DELETE FROM payment_range_challenges WHERE caller_key = $1",
    [caller],
  );
  await pool.query("DELETE FROM payment_challenges WHERE caller_key = $1", [
    caller,
  ]);
  const stores = [
    createPostgresPaymentChallengeStore(),
    createPostgresPaymentChallengeStore(),
  ];
  let attempts = 0;
  const policy = {
    now: Date.now,
    reuseMs: 60_000,
    limitWindowMs: 60_000,
    maxInvoicesPerWindow: 2,
    maxCallers: 10_000,
  };
  const fail = async () => {
    attempts += 1;
    throw new Error("wallet unavailable");
  };

  try {
    await assert.rejects(stores[0].getOrCreate(caller, "days-1", policy, fail));
    await assert.rejects(stores[1].getOrCreate(caller, "days-10", policy, fail));
    const limited = await stores[0].getOrCreate(
      caller,
      "from-2026-09-01",
      policy,
      fail,
    );
    assert.equal(limited.kind, "limited");
    assert.equal(attempts, 2);
  } finally {
    await pool.query(
      "DELETE FROM payment_range_challenges WHERE caller_key = $1",
      [caller],
    );
    await pool.query(
      "DELETE FROM payment_challenges WHERE caller_key = $1",
      [caller],
    );
  }
});

test("evicts inactive callers so cache capacity recovers", async () => {
  let now = 0;
  let requests = 0;
  const capacityApp = express();
  capacityApp.set("trust proxy", 1);
  registerStratigraphyRoutes(
    capacityApp,
    () => ({
      lookupInvoice: async () => validTransaction as never,
      makeInvoice: async () => {
        requests += 1;
        return validTransaction as never;
      },
      close: () => undefined,
    }),
    {
      now: () => now,
      reuseMs: 100,
      limitWindowMs: 1_000,
      maxInvoicesPerWindow: 3,
      maxCallers: 2,
    },
    createMemoryPaymentChallengeStore(),
  );
  const capacityServer = capacityApp.listen(0);
  await new Promise<void>((resolve) =>
    capacityServer.once("listening", resolve),
  );
  const address = capacityServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/v1/stratigraphy`;

  try {
    for (const ip of ["198.51.100.1", "198.51.100.2"]) {
      assert.equal(
        (await fetch(url, { headers: { "X-Forwarded-For": ip } })).status,
        402,
      );
    }
    const limited = await fetch(url, {
      headers: { "X-Forwarded-For": "198.51.100.3" },
    });
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1);
    assert.deepEqual(await limited.json(), {
      error: "Too many payment invoices requested",
      code: "payment_challenge_rate_limited",
      retry_after: retryAfter,
    });

    now = 1_001;
    assert.equal(
      (
        await fetch(url, {
          headers: { "X-Forwarded-For": "198.51.100.3" },
        })
      ).status,
      402,
    );
    assert.equal(requests, 9);
  } finally {
    capacityServer.close();
  }
});

test("failed invoice attempts consume quota and retain caller capacity", async () => {
  let now = 0;
  let attempts = 0;
  const failureApp = express();
  failureApp.set("trust proxy", 1);
  failureApp.use((req, _res, next) => {
    (req as any).log = {
      error: () => undefined,
    };
    next();
  });
  registerStratigraphyRoutes(
    failureApp,
    () => ({
      lookupInvoice: async () => validTransaction as never,
      makeInvoice: async () => {
        attempts += 1;
        throw new Error("wallet unavailable");
      },
      close: () => undefined,
    }),
    {
      now: () => now,
      reuseMs: 100,
      limitWindowMs: 1_000,
      maxInvoicesPerWindow: 2,
      maxCallers: 1,
    },
    createMemoryPaymentChallengeStore(),
  );
  const failureServer = failureApp.listen(0);
  await new Promise<void>((resolve) =>
    failureServer.once("listening", resolve),
  );
  const address = failureServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/v1/stratigraphy`;

  try {
    for (let index = 0; index < 2; index += 1) {
      assert.equal(
        (
          await fetch(url, {
            headers: { "X-Forwarded-For": "203.0.113.1" },
          })
        ).status,
        502,
      );
    }
    const callerLimited = await fetch(url, {
      headers: { "X-Forwarded-For": "203.0.113.1" },
    });
    assert.equal(callerLimited.status, 429);
    assert.equal(attempts, 2);

    const capacityLimited = await fetch(url, {
      headers: { "X-Forwarded-For": "203.0.113.2" },
    });
    assert.equal(capacityLimited.status, 429);
    assert.equal(attempts, 2);

    now = 1_001;
    assert.equal(
      (
        await fetch(url, {
          headers: { "X-Forwarded-For": "203.0.113.2" },
        })
      ).status,
      502,
    );
    assert.equal(attempts, 3);
  } finally {
    failureServer.close();
  }
});

test("memory store reuses ranges and preserves caller quota after consume", async () => {
  const store = createMemoryPaymentChallengeStore();
  const policy = {
    now: Date.now,
    reuseMs: 60_000,
    limitWindowMs: 60_000,
    maxInvoicesPerWindow: 3,
    maxCallers: 10,
  };
  let creations = 0;
  const create = async () => {
    creations += 1;
    return { invoice, paymentHash, issuedAt: policy.now() };
  };

  await store.getOrCreate("caller", "days-1", policy, create);
  await store.getOrCreate("caller", "days-10", policy, create);
  await store.getOrCreate("caller", "days-1", policy, create);
  assert.equal(creations, 2);

  await store.consume("caller", "days-1", paymentHash);
  await store.getOrCreate("caller", "days-1", policy, create);
  assert.equal(creations, 3);
  await store.consume("caller", "days-10", paymentHash);
  const limited = await store.getOrCreate(
    "caller",
    "days-10",
    policy,
    create,
  );
  assert.equal(limited.kind, "limited");
  assert.equal(creations, 3);
});

test("returns a generic 502 and closes the wallet when invoice creation is rejected", async () => {
  let closeCount = 0;

  await withContractServer(
    () => ({
      lookupInvoice: async () => validTransaction as never,
      makeInvoice: async () => {
        throw new Error("wallet connection exposed detail");
      },
      close: () => {
        closeCount += 1;
      },
    }),
    async (url) => {
      const response = await fetch(url);

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "Unable to create payment invoice",
      });
      assert.equal(closeCount, 1);
    },
  );
});

test("coalesces concurrent rejected invoice attempts and allows a later retry", async () => {
  let attemptCount = 0;
  let closeCount = 0;
  let rejectSharedAttempt!: (reason?: unknown) => void;
  const sharedAttempt = new Promise<never>((_resolve, reject) => {
    rejectSharedAttempt = reject;
  });

  await withContractServer(
    () => ({
      lookupInvoice: async () => validTransaction as never,
      makeInvoice: async () => {
        attemptCount += 1;
        if (attemptCount === 1) return sharedAttempt;
        throw new Error("wallet remains unavailable");
      },
      close: () => {
        closeCount += 1;
      },
    }),
    async (url) => {
      const responsePromises = Array.from({ length: 10 }, () => fetch(url));
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.equal(attemptCount, 1);
      rejectSharedAttempt(new Error("shared wallet outage"));

      const responses = await Promise.all(responsePromises);
      assert.ok(responses.every((response) => response.status === 502));
      assert.deepEqual(
        await Promise.all(responses.map((response) => response.json())),
        Array.from({ length: responses.length }, () => ({
          error: "Unable to create payment invoice",
        })),
      );
      assert.equal(attemptCount, 1);
      assert.equal(closeCount, 1);

      const retry = await fetch(url);
      assert.equal(retry.status, 502);
      assert.deepEqual(await retry.json(), {
        error: "Unable to create payment invoice",
      });
      assert.equal(attemptCount, 2);
      assert.equal(closeCount, 2);
    },
  );
});

test("returns a generic 502 and closes the wallet for an incomplete invoice", async () => {
  let closeCount = 0;

  await withContractServer(
    () => ({
      lookupInvoice: async () => validTransaction as never,
      makeInvoice: async () =>
        ({
          ...validTransaction,
          invoice: "",
          payment_hash: "not-a-payment-hash",
        }) as never,
      close: () => {
        closeCount += 1;
      },
    }),
    async (url) => {
      const response = await fetch(url);

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "Unable to create payment invoice",
      });
      assert.equal(closeCount, 1);
    },
  );
});

test("rejects a legacy proof without a stored issuing provider", async () => {
  let closeCount = 0;
  let makeInvoiceCount = 0;

  await withContractServer(
    () => ({
      lookupInvoice: async () => {
        throw new Error("wallet lookup exposed detail");
      },
      makeInvoice: async () => {
        makeInvoiceCount += 1;
        return validTransaction as never;
      },
      close: () => {
        closeCount += 1;
      },
    }),
    async (url) => {
      const response = await fetch(url, {
        headers: { Authorization: `L402 ${paymentHash}:${preimage}` },
      });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: "Invalid payment challenge",
      });
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal(makeInvoiceCount, 0);
      assert.equal(closeCount, 0);
    },
  );
});

test("rejects a preimage that does not match the payment hash", async () => {
  transaction = validTransaction;
  const response = await fetch(`${baseUrl}/api/v1/stratigraphy`, {
    headers: { Authorization: `L402 ${paymentHash}:${"22".repeat(32)}` },
  });
  assert.equal(response.status, 402);
});

for (const [name, unsuitable] of [
  ["underpaid", { amount: fullDatasetAmountMsats - 1 }],
  ["overpaid", { amount: fullDatasetAmountMsats + 1 }],
  ["unrelated", { description: "A different purchase" }],
  ["outgoing", { type: "outgoing" }],
  ["pending", { state: "pending" }],
  ["wrong payment hash", { payment_hash: "aa".repeat(32) }],
  ["wrong wallet preimage", { preimage: "bb".repeat(32) }],
] as const) {
  test(`rejects ${name} NWC transactions`, async () => {
    transaction = { ...validTransaction, ...unsuitable } as Transaction;
    const response = await fetch(`${baseUrl}/api/v1/stratigraphy`, {
      headers: { Authorization: `L402 ${paymentHash}:${preimage}` },
    });
    assert.equal(response.status, 402);
  });
}

test("returns the full dataset for a suitable payment", async () => {
  transaction = validTransaction;
  const response = await fetch(`${baseUrl}/api/v1/stratigraphy`, {
    headers: { Authorization: `L402 ${paymentHash}:${preimage}` },
  });
  assert.equal(response.status, 200);
  const body = (await assertValidReceipt(response, paymentHash)) as {
    data: Array<
      Record<string, unknown> & {
        attestation: {
          payload_sha256: string;
          event: Parameters<typeof verifyEvent>[0];
        };
      }
    >;
    zkProof: Record<string, unknown>;
    meshConsensus: {
      quorumScore: number;
      peerAttestations: Array<{ pubkey: string; signature: string }>;
      merkleRoot: string;
      isolationMode: boolean;
    };
  };
  assert.ok(body.data.length > 5);
  assert.ok(body.zkProof);
  assert.equal(body.meshConsensus.quorumScore, 1);
  assert.equal(body.meshConsensus.isolationMode, true);
  assert.equal(body.meshConsensus.peerAttestations.length, 1);
  assert.match(body.meshConsensus.peerAttestations[0]!.pubkey, /^[0-9a-f]{64}$/);
  assert.match(body.meshConsensus.peerAttestations[0]!.signature, /^[0-9a-f]{128}$/);
  assert.match(body.meshConsensus.merkleRoot, /^[0-9a-f]{64}$/);
  const { attestation, ...unsignedRecord } = body.data[0];
  assert.deepEqual(JSON.parse(attestation.event.content), unsignedRecord);
  assert.equal(
    createHash("sha256").update(attestation.event.content).digest("hex"),
    attestation.payload_sha256,
  );
  assert.equal(attestation.event.kind, 30078);
  assert.equal(verifyEvent(attestation.event), true);
  const repeatedResponse = await fetch(`${baseUrl}/api/v1/stratigraphy`, {
    headers: { Authorization: `L402 ${paymentHash}:${preimage}` },
  });
  assert.equal(repeatedResponse.status, 200);
  const repeatedBody = (await repeatedResponse.json()) as typeof body;
  assert.ok(
    repeatedBody.data[0].attestation.event.created_at >=
      attestation.event.created_at,
  );
  assert.equal(verifyEvent(repeatedBody.data[0].attestation.event), true);
});

test("prices recent-day ranges at one sat per day with a five-sat minimum", async () => {
  for (const [days, amount, description] of [
    [1, 5_000, "Bitcoin Stratigraphy days 422-422 (1 day) access"],
    [10, 10_000, "Bitcoin Stratigraphy days 413-422 (10 days) access"],
  ] as const) {
    invoiceRequest = undefined;
    const response = await fetch(
      `${baseUrl}/api/v1/stratigraphy?days=${days}`,
    );
    assert.equal(response.status, 402);
    assert.deepEqual(invoiceRequest, {
      amount,
      description,
      expiry: 3600,
    });
  }
});

test("maps from dates from the September 9, 2026 day-422 anchor", async () => {
  invoiceRequest = undefined;
  const response = await fetch(
    `${baseUrl}/api/v1/stratigraphy?from=2026-09-01`,
  );
  assert.equal(response.status, 402);
  assert.deepEqual(invoiceRequest, {
    amount: 9_000,
    description: "Bitcoin Stratigraphy days 414-422 (9 days) access",
    expiry: 3600,
  });
});

test("returns only the paid range and rejects a cheaper range proof", async () => {
  transaction = {
    ...validTransaction,
    amount: 10_000,
    description: "Bitcoin Stratigraphy days 413-422 (10 days) access",
  };
  const paidResponse = await fetch(
    `${baseUrl}/api/v1/stratigraphy?days=10`,
    { headers: { Authorization: `L402 ${paymentHash}:${preimage}` } },
  );
  assert.equal(paidResponse.status, 200);
  const paidBody = (await paidResponse.json()) as { data: Array<{ day: number }> };
  assert.equal(paidBody.data.length, 10);
  assert.equal(paidBody.data[0].day, 413);
  assert.equal(paidBody.data.at(-1)?.day, 422);

  transaction = {
    ...validTransaction,
    amount: 5_000,
    description: "Bitcoin Stratigraphy days 422-422 (1 day) access",
  };
  const replayResponse = await fetch(
    `${baseUrl}/api/v1/stratigraphy?days=10`,
    { headers: { Authorization: `L402 ${paymentHash}:${preimage}` } },
  );
  assert.ok([402, 429].includes(replayResponse.status));
});

test("rejects invalid or conflicting ranges before creating an invoice", async () => {
  const requestsBefore = invoiceRequestCount;
  for (const query of [
    "days=0",
    "days=423",
    "days=1.5",
    "from=2026-02-30",
    "from=2026-09-10",
    "days=5&from=2026-09-01",
  ]) {
    const response = await fetch(
      `${baseUrl}/api/v1/stratigraphy?${query}`,
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "Invalid stratigraphy range");
  }
  assert.equal(invoiceRequestCount, requestsBefore);
});

test("keeps the free sample at exactly five records", async () => {
  const response = await fetch(`${baseUrl}/api/v1/stratigraphy/sample`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Array<{
    quantitative_alpha?: {
      target_multiplier?: unknown;
      difficulty_epoch_progress?: unknown;
      thermodynamic_signal?: unknown;
    };
  }>;
  assert.equal(body.length, 5);
  for (const entry of body) {
    assert.equal(
      typeof entry.quantitative_alpha?.target_multiplier,
      "number",
    );
    assert.match(
      String(entry.quantitative_alpha?.difficulty_epoch_progress),
      /^(100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)%$/,
    );
    assert.equal(
      typeof entry.quantitative_alpha?.thermodynamic_signal,
      "string",
    );
  }
});

test("serves a public, verifiable JSONL export and a crawler schema manifest", async () => {
  const invoicesBefore = invoiceRequestCount;
  const exported = await fetch(`${baseUrl}/api/export/huggingface`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal(exported.headers.get("www-authenticate"), null);
  const text = await exported.text();
  assert.ok(text.endsWith("\n"));
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 422);
  const rows = lines.map((line) => JSON.parse(line) as Record<string, any>);
  assert.ok(rows.every((row) => row.zk_proof_status === "unavailable"));
  assert.equal(rows.at(-1)?.height, 920000);
  assert.equal(rows.at(-1)?.timestamp, "2026-09-09T00:00:00.000Z");
  assert.equal(rows[0].height, 920000 - 421 * 144);
  for (const row of [rows[0], rows.at(-1)!]) {
    assert.equal(row.record_hash, createHash("sha256").update(JSON.stringify([
      row.day, row.title, row.video_id, row.transcript_summary,
      row.target_multiplier, row.difficulty_epoch_progress, row.thermodynamic_signal,
    ])).digest("hex"));
    assert.match(row.instruction, /thermodynamic truth/);
    assert.equal(row.prompt, `### Instruction:\n${row.instruction}\n### Response:\n`);
    assert.match(row.response, /not independently measured physical truth/);
  }
  const json = await fetch(`${baseUrl}/api/export/huggingface?format=json&limit=2`);
  assert.equal(json.status, 200);
  assert.match(json.headers.get("content-type") ?? "", /application\/json/);
  const selected = await json.json() as typeof rows;
  assert.deepEqual(selected, rows.slice(-2));
  for (const query of ["limit=0", "limit=501", "limit=abc", "limit=1&limit=2", "format=csv", "extra=1"]) {
    const response = await fetch(`${baseUrl}/api/export/huggingface?${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.equal(invoiceRequestCount, invoicesBefore);
  const schema = await fetch(`${baseUrl}/.well-known/llm-schema.json`);
  assert.equal(schema.status, 200);
  const manifest = await schema.json() as Record<string, any>;
  assert.equal(manifest.endpoints.export, "/api/export/huggingface");
  assert.equal(manifest.parameters.limit.default, 500);
  assert.deepEqual(manifest.parameters.format.enum, ["jsonl", "json"]);
  assert.deepEqual(manifest.record_schema, (openApiDocument as any).components.schemas.HuggingFaceExportRecord);
  assert.match(manifest.verification_protocols.record_hash.canonicalization, /JSON\.stringify/);
  assert.match(manifest.domain_constraints.proof_availability, /no per-record ZK proofs/);
  assert.equal((openApiDocument as any).paths["/export/huggingface"].get.security.length, 0);
  assert.equal((openApiDocument as any).paths["/.well-known/llm-schema.json"].get.servers[0].url, "/");
});

test("supplies nonzero quantitative multipliers across the primary dataset", async () => {
  const dataset = await readDataset();
  assert.equal(dataset.length, 422);
  assert.ok(
    dataset.every(
      (entry) =>
        Number.isFinite(entry.quantitative_alpha.target_multiplier) &&
        entry.quantitative_alpha.target_multiplier > 0,
    ),
  );
});

test("keeps the legacy full-data route unavailable", async () => {
  const response = await fetch(`${baseUrl}/api/stratigraphy`);
  assert.equal(response.status, 404);
});