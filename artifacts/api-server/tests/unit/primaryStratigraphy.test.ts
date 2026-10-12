import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerMcpRoute } from "../../src/routes/mcp";
import { createPrimaryStratigraphyBackend, PrimaryStratigraphyUnavailable } from "../../src/services/primaryStratigraphy";
import type { SettlementRouter } from "../../src/services/settlement";
import { attenuateSubscriptionMacaroon, getMacaroonSignatureId } from "../../src/lib/subscription-pass";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";

const metrics = {
  block_height: 971100, observed_at_utc: "2026-10-12T12:00:00+00:00",
  btc_price_usd: 80000, hal_finney_horizon_target_usd: 10000000,
  hal_finney_horizon_multiple: 125, efficiency_baseline_j_th: 15,
  network_hashrate_h_s: 1e21, network_hashrate_th_s: 1e9, network_energy_watts: 15e9,
  attribution: "Projected by Hal Finney on January 10, 2009 ($10M per coin valuation under total global wealth absorption).",
};
const result = {
  records: [metrics], live_metrics: metrics, historical_proofs: [],
  proofAvailable: false, archive_state: "no_archives",
  proof_coverage: "Exact archived snapshot_json only; changing live_metrics are not covered.",
};

test("the bridge signs exact requests, reads current cloud bytes, and has no result cache", async () => {
  let calls = 0;
  const secret = "test-internal-bridge-secret";
  const backend = createPrimaryStratigraphyBackend({
    secret,
    fetch: async (url, input) => {
      calls++;
      assert.equal(url, "http://127.0.0.1:8000/agent-api/internal/stratigraphy");
      const headers = new Headers(input?.headers);
      const time = headers.get("x-stratigraphy-time");
      const nonce = headers.get("x-stratigraphy-nonce");
      assert.match(nonce ?? "", /^[a-f0-9]{32}$/);
      assert.equal(headers.get("x-stratigraphy-signature"), createHmac("sha256", secret)
        .update(`${time}\n${nonce}\n${input?.body}`).digest("hex"));
      assert.deepEqual(JSON.parse(String(input?.body)), {
        tool: "stratigraphy.get", arguments: { date: "2026-10-12" },
      });
      assert.ok(input?.signal);
      return Response.json({
        result: { ...result, historical_proofs: [{ ots_proof_base64: calls === 1 ? "AQID" : "BAUG" }] },
        targetHeights: [971100],
      });
    },
  });
  const first = await backend("stratigraphy.get", { date: "2026-10-12" });
  const second = await backend("stratigraphy.get", { date: "2026-10-12" });
  assert.notDeepEqual(first.result.historical_proofs, second.result.historical_proofs);
  assert.equal(calls, 2);
});

test("invalid targets and unavailable/incomplete sources fail explicitly", async () => {
  for (const status of [404, 422, 409, 503]) {
    const backend = createPrimaryStratigraphyBackend({
      secret: "test-only", fetch: async () => new Response("", { status }),
    });
    await assert.rejects(backend("stratigraphy.get", {}), status === 404 || status === 422
      ? RangeError : PrimaryStratigraphyUnavailable);
  }
  const malformed = createPrimaryStratigraphyBackend({
    secret: "test-only", fetch: async () => Response.json({ result: {}, targetHeights: [-1] }),
  });
  await assert.rejects(malformed("stratigraphy.get", {}), PrimaryStratigraphyUnavailable);
});

test("the canonical live route preserves L402, actual-height caveats and revocation", async () => {
  const preimage = "ab".repeat(32);
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  const invoices = new Map<string, { amount: number; description: string }>();
  const router: SettlementRouter = {
    isConfigured: () => true, activeProvider: () => "primary-test", circuitState: () => "closed",
    createInvoice: async (input) => {
      invoices.set(hash, { amount: input.amountMsats, description: input.description });
      return { invoice: "lnbc-primary-test", paymentHash: hash, provider: "primary-test" };
    },
    verifyPayment: async (input) => {
      const issued = invoices.get(input.paymentHash);
      return input.preimage === preimage && issued?.amount === input.expectedAmountMsats
        && issued?.description === input.expectedDescription
        ? { provider: "primary-test", settledAt: Date.now() } : "invalid";
    },
  };
  const revocations = createMemoryMacaroonRevocationStore();
  let sourceCalls = 0;
  const app = express();
  app.use(express.json());
  registerMcpRoute(app, {
    settlementRouter: router, sessionSecret: "primary-test-secret",
    revocationStore: revocations, x402ResourceServer: null,
    stratigraphyBackend: async (name) => {
      sourceCalls++;
      return name === "stratigraphy.list"
        ? { result: { totalSnapshots: 0, liveBlockHeight: 971100 }, targetHeights: [] }
        : { result, targetHeights: [971100] };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  async function call(method: string, params = {}, authorization?: string) {
    const response = await fetch(url, {
      method: "POST", headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { response, body: await response.json() };
  }
  try {
    const list = await call("tools/list");
    assert.equal(list.body.result.tools.length, 15);
    const params = { name: "stratigraphy.get", arguments: {} };
    const challenge = await call("tools/call", params);
    assert.equal(challenge.response.status, 402);
    assert.equal(sourceCalls, 0, "unpaid full reads must not invoke the source");
    const macaroon = challenge.body.macaroon;
    assert.equal(typeof macaroon, "string");
    const wrong = await call("tools/call", params, `L402 ${macaroon}:${"00".repeat(32)}`);
    assert.equal(wrong.response.status, 402);
    const paid = await call("tools/call", params, `L402 ${macaroon}:${preimage}`);
    assert.equal(paid.response.status, 200);
    assert.equal(paid.body.result.structuredContent.live_metrics.network_energy_watts, 15e9);
    assert.equal(paid.body.result.structuredContent.live_metrics.hal_finney_horizon_multiple, 125);
    const child = attenuateSubscriptionMacaroon(macaroon, ["max_target=970000"]);
    assert.ok(child);
    const bounded = await call("tools/call", params, `L402 ${child}:${preimage}`);
    assert.equal(bounded.response.status, 403, "real live height must reject a lower delegated bound");
    const free = await call("tools/call", { name: "stratigraphy.list", arguments: {} });
    assert.equal(free.response.status, 200);
    assert.equal(free.body.result.structuredContent.live_metrics, undefined);
    await revocations.revoke(getMacaroonSignatureId(macaroon)!);
    const revoked = await call("tools/call", params, `L402 ${macaroon}:${preimage}`);
    assert.equal(revoked.response.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
