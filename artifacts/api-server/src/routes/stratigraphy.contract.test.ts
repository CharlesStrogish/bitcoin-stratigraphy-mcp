import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { parse } from "yaml";
import { openApiDocument } from "../openapi";
import healthRouter from "./health";
import { registerMcpRequestGuard, registerMcpRoute } from "./mcp";
import type { SettlementRouter } from "../services/settlement";
import {
  glamaConnector,
  mcpServerCard,
  registerMcpServerCardRoute,
} from "./mcp-server-card";
import { registerOpenApiRoute } from "./openapi";
import { readDataset, registerStratigraphyRoutes } from "./stratigraphy";
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
  verifyEvent,
} from "nostr-tools";
import { createMemoryMacaroonRevocationStore } from "../lib/macaroon-revocation-store";
import { createPostgresMacaroonRevocationStore } from "../lib/postgres-macaroon-revocation-store";
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
) {
  const contractApp = express();
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

async function mcpRequest(method: string, params?: Record<string, unknown>) {
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
  let response = await fetch(`${baseUrl}/mcp`, {
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
    const expected = ["stratigraphy.list", "proof.list", "proof.status"].includes(String(params?.name))
      ? 10 : 250;
    assert.equal(challenge.amount_sats, expected);
    assert.match(response.headers.get("www-authenticate") ?? "", /L402 macaroon=".+", invoice="ln.+"/);
    assert.ok(challenge.invoice.startsWith("ln"));
    const payment = mcpInvoices.get(challenge.payment_hash);
    assert.ok(payment);
    response = await fetch(`${baseUrl}/mcp`, {
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
) {
  const response = await fetch(`${targetBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
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

test("MCP L402 challenges bind price and tool, while discovery and mesh stay free", async () => {
  for (const [method, params] of [
    ["initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pricing-test", version: "1" } }],
    ["tools/list", {}],
    ["tools/call", { name: "mesh.status", arguments: {} }],
  ] as const) {
    const { response } = await mcpRequestAt(baseUrl, method, params);
    assert.equal(response.status, 200, method);
    assert.equal(response.headers.get("www-authenticate"), null);
  }

  const lowArgs = { name: "proof.status", arguments: { snapshotDigest: "1" } };
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
  const { response: invalidParams, body: invalidBody } = await mcpRequestAt(
    baseUrl, "tools/call", { name: "proof.status", arguments: { snapshotDigest: "" } },
  );
  assert.equal(invalidParams.status, 200);
  assert.equal(invalidBody.error?.code, -32602);
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

test("exposes the stratigraphy MCP tool with structured quantitative data", async () => {
  const initialized = await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1.0.0" },
  });
  assert.equal(initialized.result?.serverInfo.name, "bitcoin-stratigraphy");

  const listed = await mcpRequest("tools/list");
  assert.deepEqual(
    listed.result?.tools.map((candidate: { name: string }) => candidate.name),
    [
      "stratigraphy.get",
      "stratigraphy.list",
      "proof.verify",
      "proof.status",
      "proof.list",
      "proof.submit",
      "proof.ground",
      "mesh.status",
    ],
  );
  for (const candidate of listed.result?.tools ?? []) {
    assert.match(
      candidate.name,
      /^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/,
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
      if (path.includes(".inputSchema")) {
        assert.ok(
          Object.hasOwn(property as object, "default"),
          `${path}.properties.${name} must define default`,
        );
      }
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
  const requiredDescriptionSections = [
    "PURPOSE:",
    "USAGE:",
    "PARAMETERS:",
    "BEHAVIOR:",
    "RETURNS:",
    "ERRORS:",
  ] as const;
  for (const candidate of listed.result?.tools ?? []) {
    const descriptionLines = candidate.description.split("\n");
    assert.equal(descriptionLines.length, requiredDescriptionSections.length);
    requiredDescriptionSections.forEach((section, index) => {
      assert.ok(
        descriptionLines[index]?.startsWith(section),
        `${candidate.name} description line ${index + 1} must start with ${section}`,
      );
      assert.ok(
        descriptionLines[index].slice(section.length).trim().length > 0,
        `${candidate.name} must provide content after ${section}`,
      );
    });
    assert.match(
      candidate.description,
      /ERRORS:.*-32602/,
      `${candidate.name} must document MCP parameter validation errors`,
    );
    assert.match(
      candidate.description,
      /USAGE: Use .+ Do NOT use .+; use .+ instead\./,
    );
    assert.match(candidate.description, /BEHAVIOR: .+ Rate limit:/);
    assert.doesNotMatch(
      candidate.description,
      /BEHAVIOR:.*\b(?:Read-only|Idempotent|Mutating|Non-idempotent)\b/,
    );
    assert.match(candidate.description, /Rate limit: 60 req\/min per IP/);
    assertDocumentedSchema(candidate.inputSchema, `${candidate.name}.inputSchema`);
    assertValidDefault(candidate.inputSchema, `${candidate.name}.inputSchema`);
    assertDocumentedSchema(
      candidate.outputSchema,
      `${candidate.name}.outputSchema`,
    );
  }
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
  assert.deepEqual(
    (queryProperties.metrics as {
      items: { type: string; enum: string[] };
    }).items,
    {
      type: "string",
      description:
        "Allowed thermodynamic metric name to include in each returned quantitative_alpha object.",
      example: "target_multiplier",
      examples: ["target_multiplier"],
      default: "target_multiplier",
      enum: [
        "target_multiplier",
        "difficulty_epoch_progress",
        "thermodynamic_signal",
      ],
    },
  );
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
    name: "mesh.status",
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

  const proofStatusCalled = await mcpRequest("tools/call", {
    name: "proof.status",
    arguments: { snapshotDigest: "1" },
  });
  assert.deepEqual(
    {
      status: proofStatusCalled.result?.structuredContent.status,
      attestationCount:
        proofStatusCalled.result?.structuredContent.attestationCount,
      meshQuorum: proofStatusCalled.result?.structuredContent.meshQuorum,
    },
    { status: "invalid", attestationCount: 0, meshQuorum: false },
  );
  assert.match(
    proofStatusCalled.result?.structuredContent.verifiedAt,
    /^\d{4}-\d{2}-\d{2}T/,
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
  assert.equal(
    submitted.result?.structuredContent.attestationStatus,
    "not_broadcast_invalid_proof",
  );
  assert.match(
    submitted.result?.structuredContent.proofHash,
    /^0x[0-9a-f]{64}$/,
  );

  const submittedStatus = await mcpRequest("tools/call", {
    name: "proof.status",
    arguments: {
      proofHash: submitted.result?.structuredContent.proofHash,
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
    ["mesh.status", { unexpected: true }],
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
    assert.equal(catalog.response.status, 402);
    assert.equal((catalog.body as any).amount_sats, 10);
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
  assert.equal(preflight.headers.get("access-control-allow-headers"), "*");

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

test("offers SSE transport without changing the public OpenAPI route", async () => {
  const abortController = new AbortController();
  const sseResponse = await fetch(`${baseUrl}/mcp`, {
    headers: {
      Accept: "text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    signal: abortController.signal,
  });
  assert.equal(sseResponse.status, 200);
  assert.match(
    sseResponse.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  abortController.abort();

  const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openApiResponse.status, 200);
  assert.equal(openApiResponse.headers.get("www-authenticate"), null);
});

test("serves the public MCP server card without an L402 challenge", async () => {
  const response = await fetch(
    `${baseUrl}/.well-known/mcp/server-card.json`,
    {
      headers: {
        Authorization: `L402 ${paymentHash}:${preimage}`,
      },
    },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.deepEqual(await response.json(), mcpServerCard);
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
    proof_status_tool: { name: string; identifiers: string[] };
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
  assert.equal(body.proof_status_tool.name, "proof.status");
  assert.deepEqual(body.proof_status_tool.identifiers, [
    "proofHash",
    "snapshotDigest",
  ]);
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