// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { powFetch as fetch } from "../helpers/pow-fetch";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { canonical } from "../../src/lib/article12-signature";
import { createMcpPipelineHandler, pipelinePlan, resolvePipelineArguments,
  PIPELINE_DOMAIN, postgresPipelineReceiptStore, type PipelineReceiptStore } from "../../src/lib/mcp-pipeline";
import { createMemoryMacaroonUsageStore } from "../../src/lib/macaroon-usage-store";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import { attenuateSubscriptionMacaroon, verifySubscriptionMacaroon } from "../../src/lib/subscription-pass";
import { indexedContractTestFixture, mcpToolDefinitions, registerMcpRoute } from "../../src/routes/mcp";
import type { SettlementRouter } from "../../src/services/settlement";

const key = generateKeyPairSync("ed25519").privateKey;
const previousKey = process.env.TOOL_INTEGRITY_PRIVATE_KEY;
process.env.TOOL_INTEGRITY_PRIVATE_KEY = key.export({type: "pkcs8", format: "pem"}).toString();
const secret = "pipeline-unit-test-secret";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const invoices = new Map<string, {preimage: string; amount: number; description: string; paid: boolean}>();
let issued = 0;
let verifications = 0;
const router: SettlementRouter = {
  isConfigured: () => true, activeProvider: () => "pipeline-test", circuitState: () => [],
  async createInvoice(input) {
    issued++;
    const preimage = sha(String(issued));
    const paymentHash = sha(Buffer.from(preimage, "hex"));
    invoices.set(paymentHash, {preimage, amount: input.amountMsats,
      description: input.description, paid: false});
    return {invoice: "lnbcpipelinetest" + issued, paymentHash, provider: "pipeline-test"};
  },
  async verifyPayment(input) {
    verifications++;
    const invoice = invoices.get(input.paymentHash);
    if (!invoice?.paid || invoice.preimage !== input.preimage ||
        invoice.amount !== input.expectedAmountMsats ||
        invoice.description !== input.expectedDescription ||
        input.expectedProvider !== "pipeline-test" || input.asset !== "btc-lightning") return "invalid";
    return {provider: "pipeline-test", settledAt: Date.now(), asset: "btc-lightning"};
  },
};
const evidence = new Map<string, Record<string, unknown>>();
let unavailable = false;
const store: PipelineReceiptStore = {
  async ready() { if (unavailable) throw new Error("database offline"); },
  async reserve(id, row) {
    if (evidence.has(id)) return false;
    evidence.set(id, structuredClone(row));
    return true;
  },
  async save(id, row) { evidence.set(id, structuredClone(row)); },
};
const revoked = createMemoryMacaroonRevocationStore();
const call = (id: number, name = "mesh.get_status", arguments_: Record<string, unknown> = {}) =>
  ({jsonrpc: "2.0", id, method: "tools/call", params: {name, arguments: arguments_}});
const pipeline = (calls = [call(1), call(2)]) => ({jsonrpc: "2.0", id: "pipeline", method: "tools/pipeline", params: {calls}});
let server: Server;
let url: string;
const executed: Record<string, unknown>[] = [];
before(async () => {
  const app = express();
  app.use(express.json());
  registerMcpRoute(app, {
    settlementRouter: router, sessionSecret: secret,
    usageStore: createMemoryMacaroonUsageStore(), revocationStore: revoked,
    pipelineReceiptStore: store, stratigraphyBackend: indexedContractTestFixture,
    meshService: {
      status: () => ({configuredPeerCount: 0, quorumThreshold: 1, peerCount: 0, pendingBroadcasts: 0}) as never,
      createConsensus: async () => { throw new Error("offline"); },
    },
  });
  // Isolated executor to exercise result references, failure and billing without
  // fetching external data or introducing test-only tools into the real catalog.
  app.post("/ordered", createMcpPipelineHandler({
    settlementRouter: router, sessionSecret: secret, usageStore: createMemoryMacaroonUsageStore(),
    revocationStore: revoked, store, key: () => key,
    schemaFor: () => z.object({value: z.number().optional(), fail: z.boolean().optional()}).strict(),
    async execute(_req, _res, _name, args) {
      executed.push(args);
      if (args.fail) return {error: {code: -32603, message: "intentional failure"}};
      return {result: {content: [], structuredContent: {value: Number(args.value ?? 0) + 1}}};
    },
  }));
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (previousKey === undefined) delete process.env.TOOL_INTEGRITY_PRIVATE_KEY;
  else process.env.TOOL_INTEGRITY_PRIVATE_KEY = previousKey;
  await pool.end();
});
let requestNumber = 0;
async function post(body: unknown, authorization?: string, path = "/mcp", extra = {}) {
  const response = await fetch(url + path, {method: "POST", headers: {
    "Content-Type": "application/json", Accept: "application/json",
    "X-Forwarded-For": `198.51.100.${++requestNumber % 200 + 1}`,
    ...(authorization ? {Authorization: authorization} : {}), ...extra,
  }, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
}
async function pay(body: unknown, path = "/mcp") {
  const challenge = await post(body, undefined, path);
  assert.equal(challenge.status, 402, JSON.stringify(challenge.body));
  const invoice = invoices.get(challenge.body.payment_hash)!;
  assert.ok(invoice);
  invoice.paid = true;
  return {challenge, authorization: `L402 ${challenge.body.macaroon}:${invoice.preimage}`};
}

test("raw single-tool and pipeline invoice requests require fresh compute before any wallet call", async () => {
  const rawPost = async (body: unknown, path: string, headers: Record<string, string> = {}) => {
    const response = await globalThis.fetch(url + path, {
      method: "POST", headers: {"Content-Type": "application/json", Accept: "application/json", ...headers},
      body: JSON.stringify(body),
    });
    return {status: response.status, body: await response.json()};
  };
  for (const path of ["/mcp", "/invoice/request"]) {
    for (const [body, extraHeaders] of [
      [call(300), {}],
      [pipeline([call(301), call(302)]), {}],
      [call(303), {"X-L402-Batch-Size": "100"}],
    ] as Array<[ReturnType<typeof call> | ReturnType<typeof pipeline>, Record<string, string>]>) {
      const count = issued;
      const missing = await rawPost(body, path, extraHeaders);
      assert.equal(missing.status, 400, JSON.stringify(missing.body));
      const pow = missing.body.proof_of_work ?? missing.body.error?.data?.proof_of_work;
      assert.ok(pow.challenge);
      const headers = {...extraHeaders, "X-L402-PoW-Challenge": pow.challenge, "X-L402-PoW-Nonce": "not-a-nonce"};
      assert.equal((await rawPost(body, path, headers)).status, 400);
      assert.equal(issued, count, "missing/invalid nonces never query Lightning");
      let nonce = 0;
      while (!sha(`${pow.challenge}:${nonce}`).startsWith("0".repeat(pow.difficulty))) nonce++;
      headers["X-L402-PoW-Nonce"] = String(nonce);
      assert.equal((await rawPost({...body, id: "altered-request"}, path, headers)).status, 400);
      assert.equal(issued, count, "a solved proof cannot be transferred to an altered request");
      const responses = await Promise.all([rawPost(body, path, headers), rawPost(body, path, headers)]);
      assert.deepEqual(responses.map(result => result.status).sort(), [400, 402]);
      assert.equal(issued, count + 1, "concurrent replay creates exactly one invoice");
      const challenge = responses.find(result => result.status === 402)!.body;
      const invoice = invoices.get(challenge.payment_hash)!;
      assert.equal(challenge.amount_sats, extraHeaders["X-L402-Batch-Size"] ? 25_000 : body.method === "tools/pipeline" ? 500 : 250);
      invoice.paid = true;
      const authorization = `L402 ${challenge.macaroon}:${invoice.preimage}`;
      // Paid credentials need no new compute and remain bound to the original call.
      const result = await rawPost(body, "/mcp", {Authorization: authorization});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      if (body.method === "tools/pipeline") assert.equal(result.body.result.status, "completed");
      assert.equal(issued, count + 1);
      for (const invoicePath of ["/invoice/request", "/invoice/request/", "/INVOICE/REQUEST"]) {
        const deniedRedemption = await rawPost(body, invoicePath, {Authorization: authorization});
        assert.equal(deniedRedemption.status, 400, "invoice-only alias cannot execute a paid request");
      }
    }
  }
});

test("one summed invoice gates the real route, receipt signatures and catalog stays at sixteen", async () => {
  const body = pipeline();
  const count = issued;
  const {challenge, authorization} = await pay(body);
  assert.equal(issued, count + 1);
  assert.equal(challenge.body.amount_sats, 500);
  assert.equal(challenge.body.max_requests, 1);
  const pass = verifySubscriptionMacaroon(challenge.body.macaroon, secret, Math.floor(Date.now()/1000))!;
  assert.equal(pass.amountMsats, 500_000);
  assert.match(pass.allowedPaths[0], /^\/mcp\/pipelines\/[0-9a-f]{64}$/);
  const result = await post(body, authorization);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.responses.length, 2);
  assert.equal(result.body.result.status, "completed");
  const receipt = result.body.result.receipt;
  const {issuer_attestation: attestation, ...unsigned} = receipt;
  assert.equal(receipt.amount_sats, 500);
  assert.equal(receipt.completed_steps, 2);
  assert.equal(receipt.steps.length, 2);
  assert.ok(verify(null, Buffer.from(PIPELINE_DOMAIN + canonical(unsigned)), createPublicKey(key),
    Buffer.from(attestation.signature, "base64")));
  const tampered = {...unsigned, amount_sats: 250};
  assert.equal(verify(null, Buffer.from(PIPELINE_DOMAIN + canonical(tampered)), createPublicKey(key),
    Buffer.from(attestation.signature, "base64")), false);
  assert.deepEqual(evidence.get("mcp-pipeline:" + challenge.body.payment_hash)?.receipt, receipt);
  assert.doesNotMatch(JSON.stringify(evidence.get("mcp-pipeline:" + challenge.body.payment_hash)),
    new RegExp(invoices.get(challenge.body.payment_hash)!.preimage));
  const retry = await post(body, authorization);
  assert.equal(retry.status, 429);
  assert.equal(mcpToolDefinitions.length, 16);
});

test("result references pass actual earlier outputs sequentially and duplicate prices are charged", async () => {
  executed.length = 0;
  const body = pipeline([call(1, "mesh.get_status", {value: 8}),
    call(2, "mesh.get_status", {value: {$ref: "0#/structuredContent/value"}})]);
  const {authorization, challenge} = await pay(body, "/ordered");
  assert.equal(challenge.body.amount_sats, 500);
  const response = await post(body, authorization, "/ordered");
  assert.equal(response.status, 200);
  assert.deepEqual(executed, [{value: 8}, {value: 9}]);
  assert.equal(response.body.result.responses[1].result.structuredContent.value, 10);
  const step = response.body.result.receipt.steps[1];
  assert.equal(step.input_sha256, sha(canonical({value: 9})));
});

test("real MCP tools compose a mesh status output into the next tool's validated input", async () => {
  const body = pipeline([call(1), call(2, "proof.list",
    {limit: {$ref: "0#/structuredContent/quorumThreshold"}})]);
  const {authorization, challenge} = await pay(body);
  assert.equal(challenge.body.amount_sats, 250);
  const result = await post(body, authorization);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.status, "completed");
  assert.equal(result.body.result.responses[1].result.structuredContent.total >= 0, true);
  assert.equal(result.body.result.receipt.steps[1].input_sha256,
    sha(canonical({limit: 1, offset: 0})));
});

test("settlement lookup inside a pipeline still verifies the original tool invoice", async () => {
  const single = await post(call(1, "payment.get_info"));
  assert.equal(single.status, 402);
  const original = invoices.get(single.body.payment_hash)!;
  original.paid = true;
  const body = pipeline([call(1, "payment.get_info", {
    action: "settle", paymentHash: single.body.payment_hash,
    paymentMacaroon: single.body.macaroon, preimage: original.preimage.toUpperCase(),
  })]);
  const {authorization} = await pay(body);
  const result = await post(body, authorization);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result.responses[0].result.structuredContent.verified, true);
  assert.equal(result.body.result.responses[0].result.structuredContent.settlementToken.paymentHash,
    single.body.payment_hash);
});

test("fail-fast receipts include the failed step without executing following tools", async () => {
  executed.length = 0;
  const body = pipeline([call(1), call(2, "mesh.get_status", {fail: true}), call(3)]);
  const {authorization} = await pay(body, "/ordered");
  const response = await post(body, authorization, "/ordered");
  assert.equal(response.body.result.status, "failed");
  assert.equal(response.body.result.responses.length, 2);
  assert.equal(executed.length, 2);
  assert.equal(response.body.result.receipt.steps[1].status, "failed");
});

test("unsettled or altered sequence credentials never execute; replay races consume one quota", async () => {
  const body = pipeline([call(1)]);
  const unpaid = await post(body);
  assert.equal(unpaid.status, 402);
  const invoice = invoices.get(unpaid.body.payment_hash)!;
  assert.notEqual((await post(body, `L402 ${unpaid.body.macaroon}:${invoice.preimage}`)).status, 200);
  const {authorization} = await pay(body);
  const changed = pipeline([call(2)]);
  assert.notEqual((await post(changed, authorization)).status, 200);
  const responses = await Promise.all([post(body, authorization), post(body, authorization)]);
  assert.deepEqual(responses.map(item => item.status).sort(), [200, 429]);
});

test("descendant restrictions, revocation, and legacy single-tool credentials cannot escape scope", async () => {
  const body = pipeline([call(1)]);
  const {challenge, authorization} = await pay(body);
  const proof = invoices.get(challenge.body.payment_hash)!.preimage;
  const limited = attenuateSubscriptionMacaroon(challenge.body.macaroon, ["rpc = mesh.get_status"])!;
  assert.equal((await post(body, `L402 ${limited}:${proof}`)).status, 403);
  const pass = verifySubscriptionMacaroon(challenge.body.macaroon, secret, Math.floor(Date.now()/1000))!;
  await revoked.revoke(pass.tokenId);
  assert.equal((await post(body, authorization)).status, 401);
  const single = await post(call(1));
  assert.equal(single.status, 402);
  const invoice = invoices.get(single.body.payment_hash)!;
  invoice.paid = true;
  assert.notEqual((await post(body, `L402 ${single.body.macaroon}:${invoice.preimage}`)).status, 200);
  assert.equal((await post(call(1), `L402 ${single.body.macaroon}:${invoice.preimage}`)).status, 200);
});

test("preflight rejects malformed, oversized, unknown, forward-reference and async steps before invoicing", async () => {
  const before = issued;
  for (const body of [
    pipeline([]), pipeline([call(1, "seventeenth.tool")]), pipeline([call(1), call(1)]),
    pipeline([call(1, "mesh.get_status", {value: {$ref: "0#/value"}})]),
    pipeline([call(1, "mesh.get_status", {webhook_url: "https://example.com"})]),
    pipeline([call(1, "mesh.get_status", {unknown: true})]),
    pipeline(Array.from({length:101}, (_, id) => call(id))),
    pipeline([call(1), {jsonrpc: "2.0", id: 2, method: "tools/list"}]),
  ]) assert.equal((await post(body)).status, 400);
  assert.equal((await post(pipeline(), undefined, "/mcp", {"X-L402-Batch-Size": "100"})).status, 400);
  assert.equal((await post(pipeline(), undefined, "/mcp", {"PAYMENT-SIGNATURE": "bad"})).status, 400);
  assert.equal(issued, before);
});

test("durable-store outage refuses before invoice issuance", async () => {
  const before = issued;
  unavailable = true;
  try { assert.equal((await post(pipeline())).status, 503); }
  finally { unavailable = false; }
  assert.equal(issued, before);
});

test("legacy arrays and modern negotiated pipeline extension work, modern arrays remain invalid", async () => {
  const calls = [call(1), call(2)];
  const {authorization} = await pay(calls);
  assert.equal((await post(calls, authorization)).status, 200);
  const modern = {...pipeline(calls), params: {calls, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  }}};
  const headers = {"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/pipeline"};
  const response = await post(modern, undefined, "/mcp", headers);
  assert.equal(response.status, 402, JSON.stringify(response.body));
  assert.ok(response.body.error.data.macaroon);
  assert.equal(response.body.macaroon, undefined);
  assert.equal((await post(calls, undefined, "/mcp", headers)).status, 400);
});

test("zero-price sandbox pipelines never create Lightning invoices", async () => {
  const before = issued;
  const response = await post(pipeline([call(1, "proof.list")]));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result.receipt.amount_sats, 0);
  assert.equal(response.body.result.receipt.payment_hash, null);
  assert.equal(issued, before);
});

test("reference resolution rejects prototype access and missing fields", () => {
  const schema = () => z.object({value: z.number()}).strict();
  assert.throws(() => pipelinePlan(pipeline([call(1, "mesh.get_status", {value: 1}),
    call(2, "mesh.get_status", {value: {$ref: "0#/__proto__"}})]), schema), /Unsafe/);
  assert.throws(() => resolvePipelineArguments({$ref: "0#/missing"}, [{}]), /does not exist/);
  assert.throws(() => pipelinePlan(pipeline([call(1, "mesh.get_status", {value: "bad"})]), schema), /Invalid/);
  assert.ok(verifications > 0);
});

test("PostgreSQL receipt reservations persist exact signatures and cannot race to overwrite an execution", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE enterprise_affiliate_security (record_key text PRIMARY KEY, payload jsonb NOT NULL) ON COMMIT DROP");
    const database = postgresPipelineReceiptStore(client);
    await database.ready();
    assert.equal(await database.reserve("mcp-pipeline:test", {status: "running"}), true);
    assert.equal(await database.reserve("mcp-pipeline:test", {status: "running"}), false);
    const row = {status: "completed", receipt: {issuer_attestation: {signature: "exact-signature"}}};
    await database.save("mcp-pipeline:test", row);
    const saved = await client.query("SELECT payload FROM pg_temp.enterprise_affiliate_security WHERE record_key=$1", ["mcp-pipeline:test"]);
    assert.deepEqual(saved.rows[0].payload, row);
    await assert.rejects(database.save("mcp-pipeline:missing", row), /reservation missing/);
  } finally { await client.query("ROLLBACK"); client.release(); }
});
