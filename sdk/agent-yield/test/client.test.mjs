// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFiduciaryYield, FiduciaryClient } from "../dist/sdk/agent-yield/src/index.js";
import { preimage, hash, invoice, json, signedFetch, serverPublicKey } from "./fixtures.mjs";

const catalog = [
  { name: "stratigraphy.list", description: "Free catalog", inputSchema: { type: "object", properties: {} } },
  { name: "proof.verify", description: "Paid verification", inputSchema: { type: "object", properties: {} } },
];

async function setup(t, options = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "agent-yield-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const bolt11 = invoice();
  const receivingInvoice = invoice(21000n);
  let payments = 0, discoveries = 0, claimInvoices = 0;
  const requests = [], errors = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.redirect, "error");
    const body = await request.clone().json();
    if (request.url === "https://bitcoinstratigraphy.com/api/claim-yield") {
      assert.deepEqual(body, {
        macaroons: ["synthetic-macaroon"], bolt11_invoice: receivingInvoice,
      });
      if (options.claimError) throw new Error("synthetic-claim-failure");
      return json({
        status: options.claimPending ? "PENDING" : "SETTLED",
        payment_sent: options.claimPending ? null : true, claim_id: "synthetic-claim",
      }, options.claimPending ? 202 : 200);
    }
    requests.push({ body, headers: request.headers, url: request.url });
    assert.equal(request.headers.get("MCP-Protocol-Version"), "2026-07-28");
    assert.equal(request.headers.get("Mcp-Method"), body.method);
    assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    if (body.method === "tools/list") {
      discoveries++;
      if (options.discoveryError) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32603 } });
      return json({ jsonrpc: "2.0", id: body.id, result: options.page
        ? options.page(body.params) : { tools: catalog } });
    }
    assert.equal(request.headers.get("Mcp-Name"), body.params.name);
    if (body.params.name === "stratigraphy.list") {
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "free" }] } });
    }
    if (options.pow && !request.headers.has("X-L402-PoW-Nonce")) {
      return json({ jsonrpc: "2.0", id: body.id, error: { code: 400, data: {
        proof_of_work: {
          algorithm: "sha256", hash_input: "challenge:nonce", challenge: "sdk-test",
          difficulty: 2, expires_at: new Date(Date.now() + 60000).toISOString(),
        },
      } } }, 400);
    }
    const quote = {
      macaroon: "synthetic-macaroon", invoice: bolt11, payment_hash: hash,
      amount_sats: options.badQuote ? 999 : 100,
    };
    if (!request.headers.get("authorization")?.startsWith("L402 ") || options.repeat402) {
      return json(options.legacy ? quote : {
        jsonrpc: "2.0", id: body.id, error: { code: 402, data: quote },
      }, 402, { "WWW-Authenticate": `L402 macaroon="${quote.macaroon}", invoice="${bolt11}"` });
    }
    assert.equal(request.headers.get("authorization"), `L402 synthetic-macaroon:${preimage}`);
    const result = { content: [], structuredContent: { verified: true } };
    if (options.toolError) result.isError = true;
    if (options.sse) return new Response(
      `: keepalive\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
    return json({ jsonrpc: "2.0", id: options.wrongId ? -1 : body.id, result });
  };
  const wallet = {
    async payInvoice(text) {
      payments++;
      assert.equal(text, bolt11);
      if (options.uncertain) throw new Error("secret-never-reflect");
      return { preimage: options.badProof ? "02".repeat(32) : preimage };
    },
    async makeInvoice(amountMsats) {
      claimInvoices++;
      assert.equal(amountMsats, 21000);
      if (options.receiving) return { invoice: receivingInvoice };
      // Yield errors must not affect successful data execution.
      throw new Error("synthetic-receiving-wallet-unavailable");
    },
  };
  const config = {
    model: "existing-model", tools: [{ name: "existing-tool" }],
    fiduciary: {
      fetch: signedFetch(fetch), serverPublicKey, wallet, stateDirectory, maxPaymentSats: 500, maxTotalSats: 5000,
      onError: event => errors.push(event), ...options.policy,
    },
  };
  return {
    config, stateDirectory, requests, errors,
    counts: () => ({ payments, discoveries, claimInvoices }),
  };
}

test("one call preserves config, discovers tools, and runs free tools without wallet payment", async t => {
  const s = await setup(t);
  const originalFetch = globalThis.fetch;
  const agent = await withFiduciaryYield(s.config);
  assert.equal(agent.model, s.config.model);
  assert.equal(agent.tools[0], s.config.tools[0]);
  assert.equal(s.config.tools.length, 1);
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(agent.tools.length, 3);
  const receipt = await agent.fiduciary.tools[0].invoke({});
  assert.deepEqual(receipt.payload, [{ type: "text", text: "free" }]);
  assert.equal(receipt.cryptographic_proof, null);
  assert.equal(receipt.thermodynamic_cost, "0");
  assert.deepEqual(s.counts(), { payments: 0, discoveries: 1, claimInvoices: 0 });
});

for (const mode of [{}, { legacy: true }, { sse: true }, { pow: true }]) {
  test(`automatic discovery/payment/retry ${JSON.stringify(mode)}`, async t => {
    const s = await setup(t, mode);
    const agent = await withFiduciaryYield(s.config);
    assert.deepEqual((await agent.fiduciary.callTool("proof.verify", { proof: "example" })).payload, { verified: true });
    await agent.fiduciary.drain();
    assert.equal(s.counts().payments, 1);
    assert.equal(s.counts().discoveries, 1);
    const calls = s.requests.filter(item => item.body.method === "tools/call");
    assert.deepEqual(calls[0].body, calls.at(-1).body);
    const state = JSON.parse(await readFile(join(s.stateDirectory, "state.json"), "utf8"));
    assert.equal(state.invoices[hash].status, "paid");
    assert.equal((await stat(join(s.stateDirectory, "state.json"))).mode & 0o777, 0o600);
    assert.ok(s.errors.some(error => error.code === "YIELD_CLAIM_REQUIRES_RECOVERY"));
  });
}

test("budget overflow fails before wallet I/O", async t => {
  const s = await setup(t, { policy: { maxPaymentSats: 99 } });
  const agent = await withFiduciaryYield(s.config);
  await assert.rejects(agent.fiduciary.callTool("proof.verify"), /SPENDING_LIMIT_EXCEEDED/);
  assert.equal(s.counts().payments, 0);
});

for (const [options, error, count] of [
  [{ badQuote: true }, /QUOTE_MISMATCH/, 0],
  [{ badProof: true }, /PAYMENT_PROOF_INVALID_DO_NOT_REPAY/, 1],
  [{ uncertain: true }, /PAYMENT_UNCERTAIN_DO_NOT_REPAY/, 1],
  [{ repeat402: true }, /MCP_HTTP_402/, 1],
]) {
  test(`fail closed ${error}`, async t => {
    const s = await setup(t, options);
    const agent = await withFiduciaryYield(s.config);
    await assert.rejects(agent.fiduciary.callTool("proof.verify"), error);
    assert.equal(s.counts().payments, count);
    if (options.uncertain || options.badProof) {
      const restarted = await withFiduciaryYield(s.config);
      await assert.rejects(restarted.fiduciary.callTool("proof.verify"), /PAYMENT_PENDING_DO_NOT_REPAY/);
      assert.equal(s.counts().payments, 1);
    }
  });
}

test("matching persisted proof is reused after restart without another payment", async t => {
  const s = await setup(t);
  const first = await withFiduciaryYield(s.config);
  await first.fiduciary.callTool("proof.verify", {});
  await first.fiduciary.drain();
  const second = await withFiduciaryYield(s.config);
  await second.fiduciary.callTool("proof.verify", {});
  await second.fiduciary.drain();
  assert.equal(s.counts().payments, 1);
});

test("a paid token cannot be replayed for changed arguments", async t => {
  const s = await setup(t);
  const agent = await withFiduciaryYield(s.config);
  await agent.fiduciary.callTool("proof.verify", { a: 1 });
  await agent.fiduciary.drain();
  await assert.rejects(agent.fiduciary.callTool("proof.verify", { a: 2 }), /PAYMENT_SCOPE_MISMATCH/);
  assert.equal(s.counts().payments, 1);
});

test("unknown tools fail locally without invoices", async t => {
  const s = await setup(t);
  const agent = await withFiduciaryYield(s.config);
  await assert.rejects(agent.fiduciary.callTool("not.advertised"), /MCP_UNKNOWN_TOOL/);
  assert.equal(s.requests.length, 1);
});

test("OpenAI bridge maps valid names back to canonical MCP tools", async t => {
  const s = await setup(t);
  const agent = await withFiduciaryYield({ ...s.config, framework: "openai" });
  const descriptor = agent.tools[1];
  assert.match(descriptor.function.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.deepEqual((await agent.fiduciary.executeTool(descriptor.function.name)).payload, [{ type: "text", text: "free" }]);
  await assert.rejects(agent.fiduciary.executeTool("unknown"), /MCP_UNKNOWN_TOOL/);
});

test("native LangChain tools invoke through the same discovered MCP transport", async t => {
  const s = await setup(t);
  const agent = await withFiduciaryYield({ ...s.config, framework: "langchain" });
  const free = agent.tools[1];
  assert.equal(typeof free.invoke, "function");
  assert.match(free.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.deepEqual((await free.invoke({})).payload, [{ type: "text", text: "free" }]);
  assert.equal(s.counts().payments, 0);
});

test("unexpected discovery paywalls never trigger wallet payments", async t => {
  const s = await setup(t);
  const client = new FiduciaryClient({
    ...s.config.fiduciary,
    fetch: async () => json({}, 402),
  });
  await assert.rejects(client.listTools(), /MCP_HTTP_402/);
  assert.equal(s.counts().payments, 0);
});

test("simultaneous requests cannot double-pay one invoice", async t => {
  const s = await setup(t);
  const agent = await withFiduciaryYield(s.config);
  const results = await Promise.allSettled([
    agent.fiduciary.callTool("proof.verify", { request: 1 }),
    agent.fiduciary.callTool("proof.verify", { request: 2 }),
  ]);
  await agent.fiduciary.drain();
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(s.counts().payments, 1);
});

test("total budget includes the fee reserve", async t => {
  const s = await setup(t, { policy: { maxTotalSats: 105 } });
  const agent = await withFiduciaryYield(s.config);
  await assert.rejects(agent.fiduciary.callTool("proof.verify"), /SPENDING_LIMIT_EXCEEDED/);
  assert.equal(s.counts().payments, 0);
});

test("discovery follows cursors and rejects cycles", async t => {
  const s = await setup(t, { page: params => params.cursor
    ? { tools: [catalog[1]] } : { tools: [catalog[0]], nextCursor: "next" } });
  const agent = await withFiduciaryYield(s.config);
  assert.equal(agent.fiduciary.tools.length, 2);
  assert.equal(s.counts().discoveries, 2);
  const cycle = await setup(t, { page: () => ({ tools: [], nextCursor: "again" }) });
  await assert.rejects(withFiduciaryYield(cycle.config), /MCP_INVALID_CURSOR/);
});

test("RPC errors, ID mismatches and tool errors are not successful results", async t => {
  const discovery = await setup(t, { discoveryError: true });
  await assert.rejects(withFiduciaryYield(discovery.config), /MCP_RPC_-32603/);
  for (const [options, error] of [
    [{ wrongId: true }, /MCP_RESPONSE_ID_MISMATCH/],
    [{ toolError: true }, /MCP_TOOL_FAILED/],
  ]) {
    const s = await setup(t, options);
    const agent = await withFiduciaryYield(s.config);
    await assert.rejects(agent.fiduciary.callTool("proof.verify"), error);
    await agent.fiduciary.drain();
    assert.equal(s.counts().claimInvoices, 0);
  }
});

test("identity is refreshed for the paid retry and Authorization is preserved separately", async t => {
  let signed = 0;
  const s = await setup(t, { policy: {
    identityHeaders: async () => ({ Authorization: `Nostr fixture-${++signed}` }),
  } });
  const agent = await withFiduciaryYield(s.config);
  await agent.fiduciary.callTool("proof.verify");
  await agent.fiduciary.drain();
  const last = s.requests.at(-1);
  assert.equal(signed, 3);
  // Original Nostr Authorization must not be lost when L402 replaces it.
  assert.equal(last.headers.get("X-Nostr-Authorization"), "Nostr fixture-3");
});

test("invalid spending policy or insecure endpoint fails before discovery", async () => {
  assert.throws(() => new FiduciaryClient({ mcpUrl: "http://example.com", maxPaymentSats: 10, maxTotalSats: 100 }), /HTTPS_MCP_URL_REQUIRED/);
  assert.throws(() => new FiduciaryClient({ wallet: {}, maxPaymentSats: 0, maxTotalSats: 100 }), /INVALID_ROUTER_POLICY/);
});

test("raw fetch preserves binary request bytes and foreign-origin 402s never pay", async t => {
  const s = await setup(t);
  let seen;
  const client = new FiduciaryClient({
    ...s.config.fiduciary,
    fetch: async request => {
      seen = Buffer.from(await request.arrayBuffer());
      return new Response("", { status: 402, headers: { "WWW-Authenticate": 'L402 macaroon="fake", invoice="fake"' } });
    },
  });
  const bytes = Uint8Array.from([0, 255, 128, 10]);
  const response = await client.fetch("https://other.example/upload", { method: "POST", body: bytes });
  assert.equal(response.status, 402);
  assert.deepEqual(seen, Buffer.from(bytes));
  assert.equal(s.counts().payments, 0);
});

function captureReceipts(t) {
  const lines = [];
  t.mock.method(console, "error", line => lines.push(line));
  // Explicitly enable receipts even if the test runner inherited quiet mode.
  const prior = process.env.QUIET_STRATIGRAPHY;
  delete process.env.QUIET_STRATIGRAPHY;
  t.after(() => {
    if (prior === undefined) delete process.env.QUIET_STRATIGRAPHY;
    else process.env.QUIET_STRATIGRAPHY = prior;
  });
  return lines;
}

test("receipts show yellow allocation then green settlement, preserving callbacks and single payment", async t => {
  const lines = captureReceipts(t);
  const events = [];
  const s = await setup(t, { receiving: true, policy: {
    onYieldClaim: event => events.push(event),
  } });
  const agent = await withFiduciaryYield(s.config);
  assert.deepEqual((await agent.fiduciary.callTool("proof.verify")).payload, { verified: true });
  await agent.fiduciary.drain();
  assert.deepEqual(lines, [
    "\x1b[33m[Bitcoin Stratigraphy] ⚡ Thermodynamic Yield Allocated: 21 Sats (settlement pending). Circuit breaker: 4890 Sats remaining.\x1b[0m",
    "\x1b[32m[Bitcoin Stratigraphy] ⚡ Thermodynamic Yield Earned: 21 Sats routed to agent wallet. Circuit breaker: 4890 Sats remaining.\x1b[0m",
  ]);
  assert.deepEqual(events, [{ status: "settled", claimId: "synthetic-claim", amountMsats: "21000" }]);
  assert.equal(s.counts().payments, 1);
  // Reusing the proof or recovering an already-settled claim adds no receipt.
  // Restart preserves the exact RPC request ID/body bound to the invoice.
  const restarted = await withFiduciaryYield(s.config);
  await restarted.fiduciary.callTool("proof.verify");
  await restarted.fiduciary.recoverClaim(hash);
  await restarted.fiduciary.drain();
  assert.equal(lines.length, 2);
  assert.equal(s.counts().payments, 1);
  assert.ok(lines.every(line => !line.includes(preimage) && !line.includes(invoice())));
});

test("quiet mode suppresses receipts without suppressing settlement or callbacks", async t => {
  const lines = captureReceipts(t);
  process.env.QUIET_STRATIGRAPHY = "true";
  const events = [];
  const s = await setup(t, { receiving: true, policy: {
    onYieldClaim: event => events.push(event),
  } });
  const agent = await withFiduciaryYield(s.config);
  await agent.fiduciary.callTool("proof.verify");
  await agent.fiduciary.drain();
  assert.deepEqual(lines, []);
  assert.equal(events[0].status, "settled");
  assert.equal(s.counts().payments, 1);
});

test("pending and failed claims show only an allocation, never earned funds", async t => {
  const lines = captureReceipts(t);
  for (const options of [{}, { receiving: true, claimPending: true }, { receiving: true, claimError: true }]) {
    const s = await setup(t, options);
    const agent = await withFiduciaryYield(s.config);
    await agent.fiduciary.callTool("proof.verify");
    await agent.fiduciary.drain();
  }
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.startsWith("\x1b[33m") && !line.includes("Earned")));
});

test("free, rejected and invalid-result flows print no yield receipts", async t => {
  const lines = captureReceipts(t);
  const free = await setup(t);
  const agent = await withFiduciaryYield(free.config);
  await agent.fiduciary.callTool("stratigraphy.list");
  for (const options of [{ badProof: true }, { repeat402: true }, { toolError: true }, { wrongId: true }]) {
    const s = await setup(t, options);
    const failed = await withFiduciaryYield(s.config);
    await assert.rejects(failed.fiduciary.callTool("proof.verify"));
    await failed.fiduciary.drain();
  }
  assert.deepEqual(lines, []);
});

test("a throwing terminal and user callback cannot break settled payment flows", async t => {
  captureReceipts(t);
  t.mock.method(console, "error", () => { throw new Error("terminal unavailable"); });
  const s = await setup(t, { receiving: true, policy: {
    onYieldClaim: async () => { throw new Error("observer unavailable"); },
  } });
  const agent = await withFiduciaryYield(s.config);
  assert.deepEqual((await agent.fiduciary.callTool("proof.verify")).payload, { verified: true });
  await agent.fiduciary.drain();
  assert.deepEqual(s.errors, []);
  assert.equal(s.counts().payments, 1);
});
