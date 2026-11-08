import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { createAgent } from "langchain";
import { FiduciaryTamperingError, withFiduciaryYield } from "@bitcoinstratigraphy/agent-yield";
import { BUDGET, ConfigurationError, loadConfig, MCP_URL } from "../config.js";
import { modelReceipt, modelSafeTools } from "../model-tools.js";
import { SYSTEM_PROMPT } from "../index.js";

// Disposable in-memory fixture keys only. No application key files are accessed.
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const fixtureEnv = () => ({
  OPENAI_API_KEY: "offline-test-only",
  NWC_URI: "nostr+walletconnect://offline-fixture-not-a-wallet",
  FIDUCIARY_SERVER_PUBLIC_KEY: publicKey,
});

async function connection(t, { tamper = false } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "fiduciary-template-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let walletCalls = 0;
  const methods = [];
  const connected = await withFiduciaryYield({
    framework: "langchain",
    tools: [],
    fiduciary: {
      ...BUDGET,
      mcpUrl: MCP_URL,
      serverPublicKey: publicKey,
      stateDirectory,
      wallet: { async payInvoice() { walletCalls++; throw new Error("LIVE_PAYMENTS_FORBIDDEN_IN_TESTS"); } },
      // Every transport request is answered locally; no fetch reaches the network.
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, MCP_URL);
        const body = await request.text();
        const rpc = JSON.parse(body);
        methods.push(rpc.method);
        let result;
        if (rpc.method === "tools/list") {
          result = { tools: [
            { name: "stratigraphy.list", description: "Read a synthetic catalog.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false } },
            { name: "clearing.settle_contract", description: "Must not be exposed.",
              inputSchema: { type: "object", properties: {} } },
          ] };
        } else {
          assert.equal(rpc.method, "tools/call");
          assert.equal(rpc.params.name, "stratigraphy.list");
          result = { content: [{ type: "text", text: "Synthetic test data." }],
            structuredContent: { date: "2026-11-08", source: "offline fixture" } };
        }
        const text = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
        const digest = createHash("sha256").update(body).digest("hex");
        const message = Buffer.from(`bitcoinstratigraphy/payload/v1\n${digest}\n${text}`);
        const signature = sign(null, message, keys.privateKey).toString("base64");
        return new Response(tamper ? text.replace("offline fixture", "modified fixture") : text, {
          headers: { "Content-Type": "application/json", "X-Stratigraphy-Signature": `v1,${signature}` },
        });
      },
    },
  });
  t.after(() => connected.fiduciary.drain());
  return { connected, methods, walletCalls: () => walletCalls };
}

test("configuration requires explicit credentials and an independently pinned public key", () => {
  const config = loadConfig(fixtureEnv());
  assert.equal(config.serverPublicKey, publicKey.trim());
  assert.equal(config.model, "gpt-4.1-mini");
  assert.equal(MCP_URL, "https://bitcoinstratigraphy.com/mcp");
  for (const name of ["OPENAI_API_KEY", "NWC_URI", "FIDUCIARY_SERVER_PUBLIC_KEY"]) {
    const env = fixtureEnv();
    delete env[name];
    assert.throws(() => loadConfig(env), (error) =>
      error instanceof ConfigurationError && error.message.includes(name));
  }
  assert.throws(() => loadConfig({ ...fixtureEnv(), NWC_URI: "secret-invalid-wallet-value" }),
    (error) => !error.message.includes("secret-invalid-wallet-value"));
  assert.throws(() => loadConfig({ ...fixtureEnv(), FIDUCIARY_SERVER_PUBLIC_KEY: "not-a-key" }),
    ConfigurationError);
  assert.ok(Object.isFrozen(BUDGET));
});

test("the real SDK discovers tools and verifies a signed response without wallet access", async (t) => {
  const fixture = await connection(t);
  const tools = modelSafeTools(fixture.connected);
  assert.equal(tools.length, 1);
  assert.ok(!tools.some((entry) => entry.name.includes("clearing")));
  const receipt = JSON.parse(await tools[0].invoke({}));
  assert.equal(receipt.provenance_verified, true);
  assert.equal(receipt.payload.source, "offline fixture");
  assert.equal("cryptographic_proof" in receipt, false);
  assert.deepEqual(fixture.methods, ["tools/list", "tools/call"]);
  assert.equal(fixture.walletCalls(), 0);
});

test("the real SDK refuses tampered signed bytes before model context", async (t) => {
  const fixture = await connection(t, { tamper: true });
  const [tool] = modelSafeTools(fixture.connected);
  await assert.rejects(tool.invoke({}), FiduciaryTamperingError);
  assert.equal(fixture.walletCalls(), 0);
});

test("model-facing receipts omit private payment credentials and reject unverified evidence", () => {
  const safe = modelReceipt({
    payload: { source: "synthetic fixture" },
    provenance_verified: true,
    cryptographic_proof: "private-payment-preimage-must-not-reach-model",
    macaroon: "private-macaroon",
    thermodynamic_cost: "1",
    timestamp: null,
  });
  assert.equal(safe.includes("private-payment"), false);
  assert.equal(safe.includes("private-macaroon"), false);
  assert.throws(() => modelReceipt({ payload: {}, provenance_verified: false }), /UNVERIFIED/);
  assert.throws(() => modelSafeTools({
    tools: [], fiduciary: { tools: [], openAITools: [] },
  }), /NO_READ_ONLY/);
});

class OfflineToolModel extends BaseChatModel {
  constructor(toolName) { super({}); this.toolName = toolName; this.calls = 0; }
  _llmType() { return "offline-fixture-model"; }
  bindTools() { return this; }
  async _generate(messages) {
    this.calls++;
    const evidence = messages.findLast((message) => message.getType() === "tool");
    if (evidence) {
      assert.equal(String(evidence.content).includes("cryptographic_proof"), false);
      const message = new AIMessage("Offline fixture: catalog record dated 2026-11-08.");
      return { generations: [{ text: message.content, message }] };
    }
    const message = new AIMessage({
      content: "",
      tool_calls: [{ id: "offline-tool-call", name: this.toolName, args: {}, type: "tool_call" }],
    });
    return { generations: [{ text: "", message }] };
  }
}

test("a real LangChain agent completes an autonomous model/tool/model loop offline", async (t) => {
  const fixture = await connection(t);
  const tools = modelSafeTools(fixture.connected);
  const model = new OfflineToolModel(tools[0].name);
  const agent = createAgent({ model, tools, systemPrompt: SYSTEM_PROMPT });
  const result = await agent.invoke({
    messages: [{ role: "user", content: "Inspect the synthetic catalog." }],
  }, { recursionLimit: 10 });
  assert.equal(model.calls, 2);
  assert.match(result.messages.at(-1).content, /2026-11-08/);
  assert.equal(fixture.walletCalls(), 0);
});

test("CLI configuration check exits without live services and reports missing settings safely", () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const good = spawnSync(process.execPath, ["index.js", "--check"], {
    cwd, encoding: "utf8", env: fixtureEnv(),
  });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /No model request, MCP request or payment was made/);
  const missing = spawnSync(process.execPath, ["index.js", "--check"], {
    cwd, encoding: "utf8", env: {},
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Set OPENAI_API_KEY/);
});

test("the distributable has no monorepo dependency and preserves the four-line wrapper", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const version of Object.values(manifest.dependencies)) {
    assert.doesNotMatch(version, /workspace:|file:|link:|github:/);
  }
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /const connected = await withFiduciaryYield\(\{\n[^\n]*\n[^\n]*\n\s*\}\);/);
  assert.ok(source.includes("// TODO: Insert your Alby / NWC Lightning credentials here to authorize L402 payments"));
});
