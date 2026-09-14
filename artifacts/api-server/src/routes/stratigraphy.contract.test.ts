import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerStratigraphyRoutes } from "./stratigraphy";

const preimage = "11".repeat(32);
const paymentHash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");
const invoice = "lnbc210n1contracttest";

type Transaction = {
  type: "incoming" | "outgoing";
  state: "settled" | "pending" | "failed";
  amount: number;
  description: string;
  payment_hash: string;
  preimage?: string;
  invoice: string;
};

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
const app = express();
registerStratigraphyRoutes(app, () => ({
  lookupInvoice: async () => transaction as never,
  makeInvoice: async (request) => {
    invoiceRequest = request;
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

test("creates a 21,000-msat invoice and returns an L402 challenge", async () => {
  invoiceRequest = undefined;
  const response = await fetch(`${baseUrl}/api/v1/stratigraphy`);

  assert.equal(response.status, 402);
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