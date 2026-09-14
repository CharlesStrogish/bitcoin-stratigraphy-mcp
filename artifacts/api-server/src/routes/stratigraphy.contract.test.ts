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
  registerStratigraphyRoutes(contractApp, clientFactory);
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
}));

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

after(() => server.close());

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
    assert.equal(
      ((await limited.json()) as { code: string }).code,
      "payment_challenge_rate_limited",
    );

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