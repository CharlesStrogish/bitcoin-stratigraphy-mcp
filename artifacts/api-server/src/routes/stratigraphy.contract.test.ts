import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { parse } from "yaml";
import { openApiDocument } from "../openapi";
import { registerStratigraphyRoutes } from "./stratigraphy";
import { createMemoryPaymentChallengeStore } from "../lib/payment-challenge-store";
import type { PaymentChallengeStore } from "../lib/payment-challenge-store";
import { createPostgresPaymentChallengeStore } from "../lib/postgres-payment-challenge-store";
import { pool } from "@workspace/db";

const preimage = "11".repeat(32);
const paymentHash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");
const invoice = "lnbc210n1contracttest";

type OpenApiDocument = {
  paths: Record<string, { get?: unknown }>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
};

function paymentContract(document: OpenApiDocument) {
  const sample = document.paths["/v1/stratigraphy/sample"]?.get as {
    responses?: unknown;
  };
  const paid = document.paths["/v1/stratigraphy"]?.get as {
    security?: unknown;
    responses?: unknown;
  };

  return {
    sample: { responses: sample?.responses },
    paid: {
      security: paid?.security,
      responses: paid?.responses,
    },
    securityScheme: document.components.securitySchemes.L402,
    challengeSchema: document.components.schemas.L402Challenge,
    rateLimitSchema:
      document.components.schemas.PaymentChallengeRateLimitError,
    walletGatewaySchema: document.components.schemas.WalletGatewayError,
    entrySchema: document.components.schemas.StratigraphyEntry,
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
  run: (url: string) => Promise<void>,
) {
  const contractApp = express();
  contractApp.use((req, _res, next) => {
    (req as any).log = {
      error: () => undefined,
    };
    next();
  });
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
    await run(
      `http://127.0.0.1:${address.port}/api/v1/stratigraphy`,
    );
  } finally {
    contractServer.close();
  }
}

const validTransaction: Transaction = {
  type: "incoming",
  state: "settled",
  amount: 21_000,
  description: "Bitcoin Stratigraphy 422-day dataset access",
  payment_hash: paymentHash,
  preimage,
  invoice,
};

let transaction = validTransaction;
let invoiceRequest: Record<string, unknown> | undefined;
let invoiceRequestCount = 0;
let invoiceGate: Promise<void> | undefined;
const app = express();
registerStratigraphyRoutes(app, () => ({
  lookupInvoice: async () => transaction as never,
  makeInvoice: async (request) => {
    invoiceRequest = request;
    invoiceRequestCount += 1;
    await invoiceGate;
    return validTransaction as never;
  },
  close: () => undefined,
}), undefined, createMemoryPaymentChallengeStore());

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
    amount: 21_000,
    description: "Bitcoin Stratigraphy 422-day dataset access",
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
    assert.equal(creations, 0);
  } finally {
    unavailableServer.close();
  }
});

test("the PostgreSQL store coalesces concurrent instance requests", async () => {
  const caller = "contract-postgres-concurrent";
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
    const first = firstStore.getOrCreate(caller, policy, create);
    const second = secondStore.getOrCreate(caller, policy, create);
    const deadline = Date.now() + 2_000;
    while (creations === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(creations, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result.kind === "challenge"));
    assert.equal(creations, 1);
  } finally {
    release();
    await pool.query(
      "DELETE FROM payment_challenges WHERE caller_key = $1",
      [caller],
    );
  }
});

test("failed PostgreSQL invoice creations consume shared quota", async () => {
  const caller = "contract-postgres-failures";
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
    await assert.rejects(stores[0].getOrCreate(caller, policy, fail));
    await assert.rejects(stores[1].getOrCreate(caller, policy, fail));
    const limited = await stores[0].getOrCreate(caller, policy, fail);
    assert.equal(limited.kind, "limited");
    assert.equal(attempts, 2);
  } finally {
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
  ["underpaid", { amount: 20_999 }],
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

test("keeps the free sample at exactly five records", async () => {
  const response = await fetch(`${baseUrl}/api/v1/stratigraphy/sample`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as unknown[];
  assert.equal(body.length, 5);
});

test("keeps the legacy full-data route unavailable", async () => {
  const response = await fetch(`${baseUrl}/api/stratigraphy`);
  assert.equal(response.status, 404);
});