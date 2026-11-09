// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import express from "express";
import { registerScannerRoute } from "./scanner";
import { analyzeScannerPrompt, scannerPromptHash } from "../lib/scanner";
import type { SettlementRouter } from "../services/settlement";
import { createMemoryMacaroonUsageStore } from "../lib/macaroon-usage-store";
import { attenuateSubscriptionMacaroon, createSubscriptionMacaroon, inspectSubscriptionMacaroon } from "../lib/subscription-pass";
import { createL402Middleware } from "../middleware/l402";
import { SCANNER_CREDIT_DESCRIPTION } from "../lib/scanner-credits";

const servers: ReturnType<ReturnType<typeof express>["listen"]>[] = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("scanner flags the three requested high-risk categories and produces a deterministic commitment", () => {
  const prompt = "Process biometric fingerprints and PII, execute trades, then autonomously deploy code to production.";
  const report = analyzeScannerPrompt(prompt);
  assert.equal(report.overall_risk_level, "High");
  assert.deepEqual(report.flagged_categories.map((f) => f.category),
    ["pii_biometric", "financial_execution", "autonomous_deployment"]);
  assert.match(report.compliance_hash, /^[0-9a-f]{64}$/);
  assert.equal(report.prompt_sha256, scannerPromptHash(prompt));
  assert.deepEqual(analyzeScannerPrompt(prompt), report);
  assert.notEqual(analyzeScannerPrompt(prompt + "!").compliance_hash, report.compliance_hash);
  assert.equal(report.receipt_type, "simulated_zk_receipt");
  assert.match(report.limitations, /not a ZK proof/);
  assert.equal(JSON.stringify(report).includes(prompt), false);
});

test("low/medium levels and contextual keyword limitations are explicit", () => {
  assert.equal(analyzeScannerPrompt("Summarize the geological layers in this landscape.").overall_risk_level, "Low");
  assert.equal(analyzeScannerPrompt("Ask an agent to organize our internal meeting agenda.").overall_risk_level, "Medium");
  assert.equal(analyzeScannerPrompt("Do not collect PII under any circumstances.").overall_risk_level, "High");
  assert.equal(analyzeScannerPrompt("Automatically push a release into production.").overall_risk_level, "High");
  assert.equal(analyzeScannerPrompt("Review customer email addresses before sharing.").overall_risk_level, "High");
  assert.equal(analyzeScannerPrompt("Autonomous code deployment is enabled for this agent.").overall_risk_level, "High");
  assert.equal(analyzeScannerPrompt("Review the record for sample@example.test before sharing.").overall_risk_level, "High");
});

test("real L402 gate binds exact prompt, retains pending invoice, verifies merchant settlement and consumes once", async () => {
  let paid = false;
  let invoices = 0;
  let lookups = 0;
  const paymentHash = createHash("sha256").update("synthetic scanner payment").digest("hex");
  const router: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "synthetic-scanner",
    circuitState: () => "closed",
    createInvoice: async (input) => {
      invoices++;
      assert.equal(input.amountMsats, 5_000_000);
      assert.equal(input.expirySeconds, 900);
      return { invoice: "lnbc1syntheticinvoice", paymentHash, provider: "synthetic-scanner", asset: "btc-lightning" };
    },
    verifyPayment: async (input) => {
      lookups++;
      assert.equal(input.paymentHash, paymentHash);
      assert.equal(input.verificationMode, "merchant-lookup");
      assert.match(input.expectedDescription ?? "", /Article 12 heuristic/);
      assert.equal(input.expectedAmountMsats, 5_000_000);
      return paid ? { settledAt: Math.floor(Date.now() / 1000), provider: "synthetic-scanner", asset: "btc-lightning" } : "invalid";
    },
  };
  const app = express();
  app.use(express.json());
  registerScannerRoute(app, {
    settlementRouter: router,
    sessionSecret: "synthetic-scanner-test-secret-not-a-real-credential",
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/scanner`;
  const prompt = "Process biometric fingerprints and execute trading orders automatically.";
  const post = (body: unknown, auth?: string, extra?: Record<string, string>) =>
    fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...extra, ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  for (const body of [{}, { prompt: "short" }, { prompt, extra: true }, { prompt: " ".repeat(25) }, { prompt: "a".repeat(20001) }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post({ prompt }, undefined, { "X-Requested-Budget": "42" })).status, 400);
  assert.equal(invoices, 0);
  const challenge = await post({ prompt });
  assert.equal(challenge.status, 402);
  assert.equal(challenge.headers.get("cache-control"), "no-store");
  assert.match(challenge.headers.get("www-authenticate")!, /^L402 macaroon="/);
  const quote = await challenge.json() as Record<string, unknown>;
  assert.equal(quote.amount_sats, 5000);
  assert.equal("overall_risk_level" in quote, false);
  const authorization = `L402 ${quote.macaroon}:NWC_LOOKUP`;
  const pending = await post({ prompt }, authorization);
  assert.equal(pending.status, 409);
  assert.equal((await pending.json() as { verification_pending: boolean }).verification_pending, true);
  assert.equal(invoices, 1);
  // The same valid capability cannot pay for a different prompt.
  const wrong = await post({ prompt: prompt + " altered" }, authorization);
  assert.notEqual(wrong.status, 200);
  assert.equal(lookups, 1);
  paid = true;
  const result = await post({ prompt }, authorization);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), analyzeScannerPrompt(prompt));
  const reused = await post({ prompt }, authorization);
  assert.notEqual(reused.status, 200);
});

test("100000-sat prepaid grants retain pending invoices and share exactly 100 credits across workers and descendants", async () => {
  const secret = "synthetic-scanner-credit-test-only";
  const hash = createHash("sha256").update("credit-invoice").digest("hex");
  let paid = false, invoices = 0, unavailable = false;
  const revoked = new Set<string>();
  const usageStore = createMemoryMacaroonUsageStore();
  const revocationStore = {
    isRevoked: async (id: string) => {
      if (unavailable) throw new Error("synthetic revocation outage");
      return revoked.has(id);
    },
    revoke: async (signatureId: string) => ({ signatureId, revokedAt: new Date() }),
  };
  const router: SettlementRouter = {
    isConfigured: () => true, activeProvider: () => "synthetic-credit", circuitState: () => "closed",
    createInvoice: async (input) => {
      invoices++;
      assert.equal(input.amountMsats, 100_000_000);
      assert.equal(input.description, SCANNER_CREDIT_DESCRIPTION);
      assert.equal(input.expirySeconds, 900);
      return { invoice: "lnbc1syntheticcredits", paymentHash: hash, provider: "synthetic-credit", asset: "btc-lightning" };
    },
    verifyPayment: async (input) => {
      assert.equal(input.paymentHash, hash);
      assert.equal(input.expectedAmountMsats, 100_000_000);
      assert.equal(input.expectedDescription, SCANNER_CREDIT_DESCRIPTION);
      return paid ? { settledAt: Math.floor(Date.now() / 1000), provider: "synthetic-credit", asset: "btc-lightning" } : "invalid";
    },
  };
  const bases: string[] = [];
  for (let worker = 0; worker < 3; worker++) {
    const app = express();
    app.use(express.json());
    registerScannerRoute(app, {
      settlementRouter: router, sessionSecret: secret, revocationStore,
      usageStore: worker === 2 ? { consume: async () => { throw new Error("synthetic quota outage"); } } : usageStore,
    });
    app.post("/other-paid-route", createL402Middleware({
      amountSats: 100_000, description: "different product", settlementRouter: router, sessionSecret: secret,
    }), (_req, res) => { res.json({ wrong: true }); });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>(resolve => server.once("listening", resolve));
    bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  const post = (path: string, body: unknown = {}, token?: string, worker = 0, scheme = "L402") =>
    fetch(bases[worker] + path, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? {
        Authorization: scheme === "Macaroon" ? `Macaroon ${token}` : `L402 ${token}:NWC_LOOKUP`,
      } : {}) },
      body: JSON.stringify(body),
    });
  assert.equal((await post("/api/mint-macaroon", { credits: 1000 })).status, 400);
  const challenge = await post("/api/mint-macaroon");
  assert.equal(challenge.status, 402);
  const quote = await challenge.json() as { amount_sats: number; credits: number; macaroon: string };
  assert.equal(quote.amount_sats, 100_000);
  assert.equal(quote.credits, 100);
  const token: string = quote.macaroon;
  const pass = inspectSubscriptionMacaroon(token, secret)!;
  assert.equal(pass.scannerCredits, 100);
  assert.deepEqual(pass.allowedPaths, ["/api/scanner"]);
  assert.equal(pass.requestLimits[0]?.maxRequests, 100);
  assert.ok(pass.validUntil > Date.now() / 1000 + 29 * 86400);
  assert.ok(JSON.parse(Buffer.from(token, "base64url").toString()).caveats.includes("credits=100"));
  assert.equal((await post("/api/mint-macaroon", {}, token)).status, 409);
  assert.equal((await post("/api/mint-macaroon", {}, token, 0, "Macaroon")).status, 409);
  assert.equal((await post("/api/scanner", { prompt: "Review this synthetic header validation test." }, "invalid-token", 0, "Macaroon")).status, 401);
  const ordinaryToken = createSubscriptionMacaroon({
    secret, paymentHash: hash, tier: "1-day", validUntil: Math.floor(Date.now() / 1000) + 900,
    amountMsats: 100_000_000, baseAmountMsats: 100_000_000,
    paymentAsset: "btc-lightning", paymentProvider: "synthetic-credit",
  });
  assert.equal((await post("/api/mint-macaroon", {}, ordinaryToken, 0, "Macaroon")).status, 401);
  const prompt = { prompt: "Review this harmless synthetic agent log for an enterprise scanner test." };
  assert.equal((await post("/api/scanner", prompt, token)).status, 409);
  assert.equal(invoices, 1);
  paid = true;
  assert.equal((await post("/api/scanner", prompt, token, 2)).status, 503);
  for (let worker = 0; worker < 2; worker++) {
    const minted = await post("/api/mint-macaroon", {}, token, worker, "Macaroon");
    assert.equal(minted.status, 200);
    assert.equal((await minted.json() as { macaroon: string }).macaroon, token);
  }
  assert.equal((await post("/api/scanner", { prompt: "short" }, token)).status, 400);
  assert.equal((await post("/other-paid-route", {}, token)).status, 403);
  const expired = attenuateSubscriptionMacaroon(token, ["time < 2000-01-01T00:00:00.000Z"])!;
  assert.equal((await post("/api/scanner", prompt, expired)).status, 401);
  const expiredRoot = attenuateSubscriptionMacaroon(createSubscriptionMacaroon({
    secret, paymentHash: hash, tier: "1-day", validUntil: Math.floor(Date.now() / 1000) - 1,
    amountMsats: 100_000_000, baseAmountMsats: 100_000_000, scannerCredits: 100,
    paymentAsset: "btc-lightning", paymentProvider: "synthetic-credit",
  }), ["allowed_path=/api/scanner"])!;
  assert.equal((await post("/api/mint-macaroon", {}, expiredRoot)).status, 401);
  assert.equal((await post("/api/scanner", prompt, expiredRoot)).status, 401);
  assert.equal(invoices, 1);
  const child = attenuateSubscriptionMacaroon(token, ["max_requests=1"])!;
  assert.equal((await post("/api/scanner", prompt, child, 0, "Macaroon")).status, 200);
  assert.equal((await post("/api/scanner", prompt, child, 1)).status, 429);
  const results = await Promise.all(Array.from({ length: 110 }, async (_, i) =>
    (await post("/api/scanner", { prompt: `${prompt.prompt} Record ${i}.` }, token, i % 2)).status));
  assert.equal(results.filter(status => status === 200).length, 99);
  assert.equal(results.filter(status => status === 429).length, 11);
  assert.equal(invoices, 1);
  // Confirmation retries are idempotent, never a quota reset.
  assert.equal((await post("/api/mint-macaroon", {}, token)).status, 200);
  assert.equal((await post("/api/scanner", prompt, token)).status, 429);
  assert.equal(invoices, 1);
  revoked.add(pass.tokenId);
  assert.equal((await post("/api/scanner", prompt, child)).status, 401);
  assert.equal((await post("/api/mint-macaroon", {}, token)).status, 401);
  unavailable = true;
  assert.equal((await post("/api/scanner", prompt, token)).status, 503);
});

test("credit caveats are issuer-only; appending a holder HMAC cannot upgrade another product", () => {
  const secret = "synthetic-issuer-only-credit-test";
  const ordinary = createSubscriptionMacaroon({
    secret, paymentHash: "cd".repeat(32), tier: "1-day", validUntil: Math.floor(Date.now() / 1000) + 900,
    amountMsats: 100_000_000, baseAmountMsats: 100_000_000,
    paymentAsset: "btc-lightning", paymentProvider: "synthetic-credit",
  });
  const forge = (caveats: string[]) => {
    const payload = JSON.parse(Buffer.from(ordinary, "base64url").toString());
    let signature = Buffer.from(payload.signature, "hex");
    for (const caveat of caveats) signature = createHmac("sha256", signature).update(caveat).digest();
    return Buffer.from(JSON.stringify({ ...payload, caveats: [...payload.caveats, ...caveats], signature: signature.toString("hex") })).toString("base64url");
  };
  assert.equal(inspectSubscriptionMacaroon(forge(["credits=100"]), secret), null);
  assert.equal(inspectSubscriptionMacaroon(forge(["credits=100", `scanner_credits_proof=${"00".repeat(32)}`]), secret), null);
  assert.equal(attenuateSubscriptionMacaroon(ordinary, ["credits=100"]), null);
  assert.throws(() => createSubscriptionMacaroon({
    secret, paymentHash: "ef".repeat(32), tier: "1-day", validUntil: 9999999999,
    amountMsats: 5_000_000, baseAmountMsats: 5_000_000, scannerCredits: 100,
    paymentAsset: "btc-lightning", paymentProvider: "synthetic-credit",
  }), /Invalid scanner credit funding/);
});
