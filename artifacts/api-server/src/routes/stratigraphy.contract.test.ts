import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { parse } from "yaml";
import { openApiDocument } from "../openapi";
import healthRouter from "./health";
import { registerMcpRoute } from "./mcp";
import {
  mcpServerCard,
  registerMcpServerCardRoute,
} from "./mcp-server-card";
import { registerOpenApiRoute } from "./openapi";
import { readDataset, registerStratigraphyRoutes } from "./stratigraphy";
import { createMemoryPaymentChallengeStore } from "../lib/payment-challenge-store";
import type { PaymentChallengeStore } from "../lib/payment-challenge-store";
import { createPostgresPaymentChallengeStore } from "../lib/postgres-payment-challenge-store";
import { pool } from "@workspace/db";

const preimage = "11".repeat(32);
const paymentHash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");
const invoice = "lnbc210n1contracttest";
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
};

let transaction = validTransaction;
let invoiceRequest: Record<string, unknown> | undefined;
let invoiceRequestCount = 0;
let invoiceGate: Promise<void> | undefined;
const app = express();
registerOpenApiRoute(app);
registerMcpServerCardRoute(app);
registerMcpRoute(app);
app.use("/api", healthRouter);
registerStratigraphyRoutes(app, () => ({
  lookupInvoice: async () => transaction as never,
  makeInvoice: async (request) => {
    invoiceRequest = request;
    invoiceRequestCount += 1;
    await invoiceGate;
    return validTransaction as never;
  },
  close: () => undefined,
}), {
  now: Date.now,
  reuseMs: 5 * 60 * 1000,
  limitWindowMs: 60 * 60 * 1000,
  maxInvoicesPerWindow: 100,
  maxCallers: 10_000,
}, createMemoryPaymentChallengeStore());

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
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    result?: Record<string, any>;
    error?: { message: string };
  };
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
    description: "L402 <payment_hash>:<preimage>",
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
      description: "Lightning payment is not configured",
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
      description: "Payment challenge coordination is unavailable",
      content: {
        "application/json": {
          schema: {
            $ref:
              "#/components/schemas/PaymentChallengeServiceUnavailableError",
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
        const: "NWC_URI is not configured",
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

test("exposes the stratigraphy MCP tool with structured quantitative data", async () => {
  const initialized = await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "contract-test", version: "1.0.0" },
  });
  assert.equal(initialized.result?.serverInfo.name, "bitcoin-stratigraphy");

  const listed = await mcpRequest("tools/list");
  const tool = listed.result?.tools.find(
    (candidate: { name: string }) =>
      candidate.name === "get_bitcoin_stratigraphy",
  );
  assert.ok(tool);

  const called = await mcpRequest("tools/call", {
    name: "get_bitcoin_stratigraphy",
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

test("serves the root OpenAPI document as raw JSON", async () => {
  const response = await fetch(`${baseUrl}/openapi.json`, {
    redirect: "manual",
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/html/);
  assert.deepEqual(await response.json(), openApiDocument);
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
        assert.equal(makeInvoiceCalls, 1);
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
  delete process.env.NWC_URI;
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
  delete process.env.NWC_URI;
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
  assert.equal(invoiceRequestCount, 1);
  assert.deepEqual(invoiceRequest, {
    amount: fullDatasetAmountMsats,
    description: fullDatasetDescription,
    expiry: 3600,
  });
  assert.equal(
    response.headers.get("www-authenticate"),
    `L402 macaroon="${paymentHash}", invoice="${invoice}"`,
  );
  assert.deepEqual(await response.json(), {
    invoice,
    payment_hash: paymentHash,
  });
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
    assert.equal(creations, 1);
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
    return { invoice, paymentHash };
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
    assert.equal(requests, 3);
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
    return { invoice, paymentHash };
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

test("returns a generic 502 without a fresh invoice when payment lookup fails", async () => {
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

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "Unable to verify payment",
      });
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal(makeInvoiceCount, 0);
      assert.equal(closeCount, 1);
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
  const body = (await response.json()) as unknown[];
  assert.ok(body.length > 5);
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
  const paidBody = (await paidResponse.json()) as Array<{ day: number }>;
  assert.equal(paidBody.length, 10);
  assert.equal(paidBody[0].day, 413);
  assert.equal(paidBody.at(-1)?.day, 422);

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