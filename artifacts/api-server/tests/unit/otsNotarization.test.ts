import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { registerMcpRoute } from "../../src/routes/mcp";
import { notarizeHash, notarizeInputSchema } from "../../src/services/otsNotarization";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import { verifySubscriptionMacaroon } from "../../src/lib/subscription-pass";
import type { SettlementRouter } from "../../src/services/settlement";

test("notary rejects malformed SHA256 digests before starting calendar work", async () => {
  for (const hash of ["", "not-hex", "gg".repeat(32), "ab".repeat(31), "ab".repeat(33), "0x" + "ab".repeat(32)]) {
    assert.equal(notarizeInputSchema.safeParse({ hash }).success, false);
    await assert.rejects(notarizeHash(hash));
  }
  assert.equal(notarizeInputSchema.safeParse({ hash: "ab".repeat(32), extra: true }).success, false);
  assert.equal(notarizeInputSchema.parse({ hash: "AB".repeat(32) }).hash, "ab".repeat(32));
});

test("proof.notarize is the paid 15th tool and issues a tool-scoped 100-call L402 challenge", async () => {
  const preimage = "01".repeat(32);
  const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  let invoices = 0;
  let verifications = 0;
  let executions = 0;
  const settlementRouter: SettlementRouter = {
    isConfigured: () => true, activeProvider: () => "test-wallet", circuitState: () => "closed",
    async createInvoice(input) {
      invoices++;
      assert.equal(input.amountMsats, 25_000_000);
      assert.equal(input.description, "Bitcoin Stratigraphy MCP proof.notarize execution (100-call batch)");
      return { invoice: "lnbc250u1notarytest", paymentHash, provider: "test-wallet" };
    },
    async verifyPayment(input) {
      verifications++;
      assert.equal(input.paymentHash, paymentHash);
      assert.equal(input.preimage, preimage);
      assert.equal(input.expectedAmountMsats, 25_000_000);
      assert.equal(input.expectedProvider, "test-wallet");
      assert.equal(input.expectedDescription, "Bitcoin Stratigraphy MCP proof.notarize execution (100-call batch)");
      return { settledAt: Date.now(), provider: "test-wallet" };
    },
  };
  const app = express();
  app.use(express.json());
  registerMcpRoute(app, {
    settlementRouter, sessionSecret: "notary-test-secret", x402ResourceServer: null,
    revocationStore: createMemoryMacaroonRevocationStore(),
    notarizeHash: async (hash) => {
      executions++;
      return { hash, otsProofHex: "004f70656e54696d657374616d70730000", otsStatus: "pending_calendar" };
    },
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const call = (method: string, params: unknown, headers: Record<string, string> = {}) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  try {
    const listing = await call("tools/list", {});
    const tools = (await listing.json()).result.tools;
    assert.equal(tools.length, 15);
    const definition = tools.find((tool: { name: string }) => tool.name === "proof.notarize");
    assert.ok(definition);
    assert.equal(definition.annotations.l402.amountSats, 250);
    assert.equal(definition.annotations.l402.batchSize, 100);
    assert.deepEqual(definition.inputSchema.required, ["hash"]);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(tools.filter((tool: { annotations: { l402: { amountSats: number } } }) =>
      tool.annotations.l402.amountSats === 0).length, 2);
    for (const hash of ["not-hex", "gg".repeat(32), "ab".repeat(31), "ab".repeat(33)]) {
      const invalid = await call("tools/call", { name: "proof.notarize", arguments: { hash } });
      assert.equal((await invalid.json()).error.code, -32602);
      assert.equal(invalid.headers.has("www-authenticate"), false);
    }
    assert.equal(invoices, 0);
    assert.equal(executions, 0);
    const params = { name: "proof.notarize", arguments: { hash: "AB".repeat(32) } };
    const otherRail = await call("tools/call", params, { "PAYMENT-SIGNATURE": "not-a-Lightning-credential" });
    assert.equal(otherRail.status, 400);
    assert.equal(invoices, 0);
    assert.equal(executions, 0);
    const challenge = await call("tools/call", params, { "X-L402-Batch-Size": "100" });
    assert.equal(challenge.status, 402);
    assert.match(challenge.headers.get("www-authenticate") ?? "", /^L402 /);
    const offer = await challenge.json();
    assert.equal(offer.amount_sats, 25_000);
    assert.equal(offer.max_requests, 100);
    const pass = verifySubscriptionMacaroon(offer.macaroon, "notary-test-secret");
    assert.ok(pass);
    assert.deepEqual(pass.allowedPaths, ["/mcp/tools/proof.notarize"]);
    assert.equal(pass.maxRequests, 100);
    assert.equal(executions, 0, "unpaid challenges never contact calendars");
    for (let i = 0; i < 2; i++) {
      const paid = await call("tools/call", params, { Authorization: `L402 ${offer.macaroon}:${preimage}` });
      assert.equal(paid.status, 200);
      const receipt = (await paid.json()).result.structuredContent;
      assert.equal(receipt.hash, "ab".repeat(32));
      assert.match(receipt.otsProofHex, /^(?:[0-9a-f]{2})+$/);
      assert.equal(receipt.otsStatus, "pending_calendar");
    }
    assert.equal(executions, 2);
    assert.equal(invoices, 1);
    assert.equal(verifications, 1, "macro settlement is reused across notarizations");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});