import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import express from "express";
import { registerScannerRoute } from "./scanner";
import { analyzeScannerPrompt, scannerPromptHash } from "../lib/scanner";
import type { SettlementRouter } from "../services/settlement";

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
      assert.ok(input.amountMsats >= 21000);
      assert.equal(input.expirySeconds, 900);
      return { invoice: "lnbc1syntheticinvoice", paymentHash, provider: "synthetic-scanner", asset: "btc-lightning" };
    },
    verifyPayment: async (input) => {
      lookups++;
      assert.equal(input.paymentHash, paymentHash);
      assert.equal(input.verificationMode, "merchant-lookup");
      assert.match(input.expectedDescription ?? "", /Article 12 heuristic/);
      assert.ok((input.expectedAmountMsats ?? 0) >= 21000);
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
