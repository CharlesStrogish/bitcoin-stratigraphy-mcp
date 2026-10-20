import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { pool } from "@workspace/db";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import {
  MCP_HEADER_MISMATCH,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
  decodeMcpHeaderValue,
  statelessErrorCode,
} from "../../src/lib/mcp-stateless";
import {
  indexedContractTestFixture,
  mcpToolDefinitions,
  registerMcpRoute,
} from "../../src/routes/mcp";
import { registerToolIntegrityRoute } from "../../src/routes/tool-integrity";
import { verifyToolResponse } from "../../src/lib/mcp-response-signature";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import type { SettlementRouter } from "../../src/services/settlement";

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const sha256Hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

type RpcError = { code: number; message: string; data?: Record<string, any> };
type RpcBody = {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, any>;
  error?: RpcError;
  [key: string]: unknown;
};
type Message = {
  jsonrpc: "2.0";
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
};

const invoices = new Map<
  string,
  { preimage: string; amountMsats: number; description: string }
>();
let invoiceCount = 0;
const settlementRouter: SettlementRouter = {
  isConfigured: () => true,
  activeProvider: () => "stateless-test",
  circuitState: () => "closed",
  createInvoice: async (input) => {
    const preimage = (++invoiceCount).toString(16).padStart(64, "0");
    const paymentHash = sha256Hex(Buffer.from(preimage, "hex"));
    invoices.set(paymentHash, {
      preimage,
      amountMsats: input.amountMsats,
      description: input.description,
    });
    return {
      invoice: `lnbc${input.amountMsats}statelesstest`,
      paymentHash,
      provider: "stateless-test",
    };
  },
  verifyPayment: async (input) => {
    const issued = invoices.get(input.paymentHash);
    return issued &&
      issued.preimage === input.preimage &&
      issued.amountMsats === input.expectedAmountMsats &&
      issued.description === input.expectedDescription &&
      input.expectedProvider === "stateless-test" &&
      input.asset === "btc-lightning"
      ? { settledAt: Date.now(), provider: "stateless-test" }
      : "invalid";
  },
};

let server: Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(
    express.json({
      verify(req, _res, buffer) {
        (req as express.Request & { rawBody?: Buffer }).rawBody =
          Buffer.from(buffer);
      },
    }),
  );
  registerMcpRoute(app, {
    stratigraphyBackend: indexedContractTestFixture,
    settlementRouter,
    sessionSecret: "stateless-transport-secret",
    x402ResourceServer: null,
    revocationStore: createMemoryMacaroonRevocationStore(),
    readBitcoinTip: async () => ({
      height: 920001,
      hash: "ab".repeat(32),
      source: "stateless-test",
    }),
  });
  registerToolIntegrityRoute(app, mcpToolDefinitions, generateKeyPairSync("ed25519").privateKey);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

const statelessMeta = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    name: "stateless-transport-test",
    version: "1.0.0",
  },
};

function stateless(
  method: string,
  params: Record<string, unknown> = {},
  id: unknown = 1,
): Message {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: statelessMeta },
  };
}

/** Headers a 2026-07-28 client sends; undefined overrides remove a header. */
function statelessHeaders(
  message: Message,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": message.method,
  };
  const name = message.params?.name;
  if (message.method === "tools/call" && typeof name === "string") {
    headers["Mcp-Name"] = name;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

const legacyHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": LEGACY,
};

async function post(
  body: unknown,
  headers: Record<string, string>,
): Promise<{ response: Response; body?: RpcBody }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? (JSON.parse(text) as RpcBody) : undefined };
}

function nip98(key: Uint8Array, payload: string): string {
  const origin = process.env.NIP98_PUBLIC_ORIGIN
    ? new URL(process.env.NIP98_PUBLIC_ORIGIN).origin
    : baseUrl;
  const event = finalizeEvent(
    {
      kind: 27_235,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["u", `${origin}/mcp`],
        ["method", "POST"],
        ["payload", sha256Hex(payload)],
      ],
      content: "",
    },
    key,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

/** Strict JSON-RPC 2.0 error shape required by 2026-07-28 clients. */
function assertStrictError(body: RpcBody | undefined, code: number): RpcError {
  assert.ok(body?.error, "expected a JSON-RPC error");
  assert.deepEqual(
    Object.keys(body).filter(
      (key) => !["jsonrpc", "id", "error"].includes(key),
    ),
    [],
  );
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  return body.error;
}

test("server/discover answers without a handshake or session", async () => {
  const message = stateless("server/discover");
  const { response, body } = await post(
    message,
    statelessHeaders(message, { "Mcp-Session-Id": "stale-session" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  assert.equal(body?.id, 1);
  const result = body?.result;
  assert.ok(result);
  assert.equal(result.supportedVersions[0], MODERN);
  assert.ok(result.supportedVersions.includes(LEGACY));
  assert.deepEqual(result.capabilities, {
    prompts: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    tools: {},
  });
  assert.equal(typeof result.instructions, "string");
  assert.equal(result.resultType, "complete");
  assert.equal(result.ttlMs, 300_000);
  assert.equal(result.cacheScope, "public");
  assert.equal(
    result._meta["io.modelcontextprotocol/serverInfo"].name,
    "bitcoin-stratigraphy",
  );
});

test("server/discover requires per-request metadata", async () => {
  const { response, body } = await post(
    { jsonrpc: "2.0", id: 2, method: "server/discover", params: {} },
    statelessHeaders({ jsonrpc: "2.0", method: "server/discover" }),
  );
  assert.equal(response.status, 400);
  assert.equal(body?.id, 2);
  assertStrictError(body, -32602);
});

test("stateless tools/list returns the cacheable catalog on any instance", async () => {
  const message = stateless("tools/list");
  const { response, body } = await post(message, statelessHeaders(message));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), null);
  const result = body?.result;
  assert.ok(result);
  assert.equal(result.tools.length, 16);
  assert.equal(result.resultType, "complete");
  assert.equal(result.ttlMs, 300_000);
  assert.equal(result.cacheScope, "public");
  assert.equal(
    result._meta["io.modelcontextprotocol/serverInfo"].version.length > 0,
    true,
  );
});

test("stateless free tool calls need matching routing headers", async () => {
  const message = stateless("tools/call", {
    name: "stratigraphy.list",
    arguments: {},
  });
  const ok = await post(message, statelessHeaders(message));
  assert.equal(ok.response.status, 200);
  assert.equal(ok.body?.result?.resultType, "complete");
  assert.equal(ok.body?.result?.ttlMs, undefined);
  assert.ok(ok.body?.result?.structuredContent);

  const encoded = `=?base64?${Buffer.from("stratigraphy.list").toString("base64")}?=`;
  const base64 = await post(
    message,
    statelessHeaders(message, { "Mcp-Name": encoded }),
  );
  assert.equal(base64.response.status, 200);

  for (const overrides of [
    { "Mcp-Method": undefined },
    { "Mcp-Method": "tools/list" },
    { "Mcp-Name": undefined },
    { "Mcp-Name": "stratigraphy.get" },
    {
      "Mcp-Name": `=?base64?${Buffer.from("proof.list").toString("base64")}?=`,
    },
    { "MCP-Protocol-Version": undefined },
  ]) {
    const { response, body } = await post(
      message,
      statelessHeaders(message, overrides),
    );
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.match(
      assertStrictError(body, MCP_HEADER_MISMATCH).message,
      /Header mismatch/,
    );
  }
});

test("a mismatched Mcp-Name cannot disguise a paid tool", async () => {
  const message = stateless("tools/call", {
    name: "stratigraphy.get",
    arguments: { days: 1 },
  });
  const { response, body } = await post(
    message,
    statelessHeaders(message, { "Mcp-Name": "stratigraphy.list" }),
  );
  assert.equal(response.status, 400);
  assertStrictError(body, MCP_HEADER_MISMATCH);
});

test("unsupported and inconsistent protocol versions are rejected", async () => {
  const future = {
    ...stateless("tools/list"),
    params: {
      _meta: {
        ...statelessMeta,
        "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      },
    },
  };
  const unsupported = await post(
    future,
    statelessHeaders(future, { "MCP-Protocol-Version": "2099-01-01" }),
  );
  assert.equal(unsupported.response.status, 400);
  const error = assertStrictError(
    unsupported.body,
    MCP_UNSUPPORTED_PROTOCOL_VERSION,
  );
  assert.equal(error.data?.requested, "2099-01-01");
  assert.equal(error.data?.supported[0], MODERN);

  const message = stateless("tools/list");
  const mixed = await post(
    message,
    statelessHeaders(message, { "MCP-Protocol-Version": LEGACY }),
  );
  assert.equal(mixed.response.status, 400);
  assertStrictError(mixed.body, MCP_HEADER_MISMATCH);
});

test("stateless requests must carry capabilities in _meta", async () => {
  const bare = {
    jsonrpc: "2.0" as const,
    id: 3,
    method: "tools/list",
    params: {},
  };
  const missing = await post(bare, statelessHeaders(bare));
  assert.equal(missing.response.status, 400);
  assert.match(
    assertStrictError(missing.body, -32602).message,
    /clientCapabilities/,
  );

  const noCapabilities = {
    ...bare,
    params: {
      _meta: { "io.modelcontextprotocol/protocolVersion": MODERN },
    },
  };
  const invalid = await post(noCapabilities, statelessHeaders(noCapabilities));
  assert.equal(invalid.response.status, 400);
  assertStrictError(invalid.body, -32602);
});

test("handshake methods are gone under 2026-07-28 with upgrade guidance", async () => {
  const initialize = stateless("initialize", {
    protocolVersion: MODERN,
    capabilities: {},
    clientInfo: { name: "old-habit", version: "1.0.0" },
  });
  const init = await post(initialize, statelessHeaders(initialize));
  assert.equal(init.response.status, 404);
  const error = assertStrictError(init.body, -32601);
  assert.match(error.message, /server\/discover/);
  assert.match(error.message, /2025-11-25/);

  for (const method of ["ping", "no/such/method"]) {
    const message = stateless(
      method,
      {},
    );
    const headers = statelessHeaders(
      message,
      {},
    );
    const { response, body } = await post(message, headers);
    assert.equal(response.status, 404, method);
    assertStrictError(body, -32601);
  }
});

test("stateless envelopes reject batches and null ids, and accept notifications", async () => {
  const batch = [
    stateless("tools/list", {}, 1),
    stateless("tools/list", {}, 2),
  ];
  const batched = await post(batch, {
    ...statelessHeaders(batch[0]!),
  });
  assert.equal(batched.response.status, 400);
  assertStrictError(batched.body, -32600);

  const nullId = stateless("tools/list", {}, null);
  const rejected = await post(nullId, statelessHeaders(nullId));
  assert.equal(rejected.response.status, 400);
  assert.equal(Object.hasOwn(rejected.body ?? {}, "id"), false);
  assertStrictError(rejected.body, -32600);

  const notification: Message = {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 1, _meta: statelessMeta },
  };
  const accepted = await post(notification, statelessHeaders(notification));
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body, undefined);
});

test("L402 challenges arrive as strict JSON-RPC data and paid retries succeed", async () => {
  const message = stateless("tools/call", {
    name: "stratigraphy.get",
    arguments: { days: 1 },
  });
  const challenge = await post(message, statelessHeaders(message));
  assert.equal(challenge.response.status, 402);
  assert.match(
    challenge.response.headers.get("www-authenticate") ?? "",
    /^L402 macaroon=".+", invoice="ln.+"$/,
  );
  const error = assertStrictError(challenge.body, 402);
  assert.equal(error.message, "Payment required");
  const data = error.data ?? {};
  assert.equal(typeof data.macaroon, "string");
  assert.equal(data.amount_sats, 250);
  const payment = invoices.get(data.payment_hash);
  assert.ok(payment);

  const paid = await post(
    message,
    statelessHeaders(message, {
      Authorization: `L402 ${data.macaroon}:${payment.preimage}`,
    }),
  );
  assert.equal(paid.response.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.response.headers.get("mcp-session-id"), null);
  assert.equal(paid.body?.result?.resultType, "complete");
  assert.ok(paid.body?.result?.structuredContent);
  assert.equal(
    paid.body?.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name,
    "bitcoin-stratigraphy",
  );
});

test("NIP-98 identities bind stateless passes through either header", async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  const message = stateless("tools/call", {
    name: "stratigraphy.get",
    arguments: { days: 1 },
  });
  const payload = JSON.stringify(message);

  const forged = await post(
    payload,
    statelessHeaders(message, { Authorization: nip98(key, `${payload} `) }),
  );
  assert.equal(forged.response.status, 401);
  assertStrictError(forged.body, 401);

  const challenge = await post(
    payload,
    statelessHeaders(message, { Authorization: nip98(key, payload) }),
  );
  assert.equal(challenge.response.status, 402);
  const data = assertStrictError(challenge.body, 402).data ?? {};
  assert.equal(data.agent_id, pubkey);
  const payment = invoices.get(data.payment_hash);
  assert.ok(payment);
  const credential = `L402 ${data.macaroon}:${payment.preimage}`;

  const anonymous = await post(
    payload,
    statelessHeaders(message, { Authorization: credential }),
  );
  assert.equal(anonymous.response.status, 401);
  assert.match(
    assertStrictError(anonymous.body, 401).message,
    /X-Nostr-Authorization/,
  );

  const paid = await post(
    payload,
    statelessHeaders(message, {
      Authorization: credential,
      "X-Nostr-Authorization": nip98(key, payload),
    }),
  );
  assert.equal(paid.response.status, 200, JSON.stringify(paid.body));
  assert.ok(paid.body?.result?.structuredContent);
});

test("handshake-era clients keep initialize and legacy payment framing", async () => {
  const init = await post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LEGACY,
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1.0.0" },
      },
    },
    legacyHeaders,
  );
  assert.equal(init.response.status, 200);
  assert.equal(init.response.headers.get("mcp-session-id"), null);
  assert.equal(init.body?.result?.protocolVersion, LEGACY);
  assert.deepEqual(init.body?.result?.capabilities?.resources, {
    subscribe: false, listChanged: false,
  });
  assert.deepEqual(init.body?.result?.capabilities?.prompts, { listChanged: false });
  assert.equal(init.body?.result?.serverInfo?.name, "bitcoin-stratigraphy");

  const list = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    legacyHeaders,
  );
  assert.equal(list.response.status, 200);
  assert.equal(list.body?.result?.tools.length, 16);
  assert.equal(list.body?.result?.resultType, undefined);

  const unpaid = await post(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "stratigraphy.get", arguments: { days: 1 } },
    },
    legacyHeaders,
  );
  assert.equal(unpaid.response.status, 402);
  assert.equal(unpaid.body?.error?.code, -32002);
  assert.equal(typeof unpaid.body?.macaroon, "string");

  const mismatched = await post(
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { ...legacyHeaders, "Mcp-Method": "tools/call" },
  );
  assert.equal(mismatched.response.status, 400);
  assert.equal(mismatched.body?.error?.code, MCP_HEADER_MISMATCH);
});

test("DELETE has no session to terminate", async () => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: { "Mcp-Session-Id": "stale-session" },
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  await response.arrayBuffer();
});

test("stateless error codes avoid the handshake-era range", () => {
  assert.equal(statelessErrorCode(-32002, 402), 402);
  assert.equal(statelessErrorCode(-32029, 429), 429);
  assert.equal(statelessErrorCode(-32001, 403), 403);
  assert.equal(statelessErrorCode(-32004, 404), 404);
  assert.equal(statelessErrorCode(-32001, 500), -32603);
  assert.equal(statelessErrorCode(-32001, 400), -32600);
  assert.equal(statelessErrorCode(-32602, 400), -32602);
  assert.equal(
    statelessErrorCode(MCP_HEADER_MISMATCH, 400),
    MCP_HEADER_MISMATCH,
  );
  assert.equal(statelessErrorCode(12_345, 200), 12_345);
  assert.equal(statelessErrorCode(-32010, 200), -32603);
});

test("Mcp-Name header values decode the base64 sentinel strictly", () => {
  const cafe = `=?base64?${Buffer.from("café").toString("base64")}?=`;
  assert.equal(decodeMcpHeaderValue(cafe, true), "café");
  assert.equal(decodeMcpHeaderValue(cafe, false), cafe);
  assert.equal(decodeMcpHeaderValue("=?base64?abc?=", true), null);
  assert.equal(decodeMcpHeaderValue("=?base64?//8=?=", true), null);
  assert.equal(decodeMcpHeaderValue("tools\u0000call", false), null);
  assert.equal(decodeMcpHeaderValue("plain.name", true), "plain.name");
});

for (const version of [MODERN, LEGACY]) {
  test(`${version}: free and paid synchronous results verify against the published integrity key`, async () => {
    const request = async (name: string, authorization?: string) => {
      const message = version === MODERN
        ? stateless("tools/call", { name, arguments: name === "stratigraphy.get" ? { days: 1 } : {} })
        : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: name === "stratigraphy.get" ? { days: 1 } : {} } };
      return post(message, {
        ...(version === MODERN ? statelessHeaders(message) : legacyHeaders),
        ...(authorization ? { Authorization: authorization } : {}),
      });
    };
    const manifest = await (await fetch(`${baseUrl}/.well-known/integrity.json`)).json();
    const key = createPublicKey(manifest.server_public_key);
    const assertSigned = (name: string, body: RpcBody | undefined) => {
      assert.ok(body?.result);
      const result = body.result as any;
      assert.equal(result._meta.responseSignature.keyId, manifest.key_id);
      assert.equal(result._meta.responseSignature.algorithm, "Ed25519");
      assert.ok(verifyToolResponse(name, result, key));
      const tampered = structuredClone(result);
      tampered.content[0].text += "!";
      assert.equal(verifyToolResponse(name, tampered, key), false);
      if (version === MODERN) {
        assert.equal(result.resultType, "complete");
        assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "bitcoin-stratigraphy");
      }
    };
    for (const name of ["stratigraphy.list", "proof.list", "stratigraphy.latest"]) {
      const response = await request(name);
      assert.equal(response.response.status, 200);
      assertSigned(name, response.body);
    }
    const challenge = await request("stratigraphy.get");
    assert.equal(challenge.response.status, 402);
    assert.equal(challenge.body?.result, undefined, "payment errors are not signed tool results");
    const data = version === MODERN ? challenge.body!.error!.data! : challenge.body!;
    const payment = invoices.get(data.payment_hash as string)!;
    const paid = await request("stratigraphy.get", `L402 ${data.macaroon}:${payment.preimage}`);
    assert.equal(paid.response.status, 200);
    assertSigned("stratigraphy.get", paid.body);
    const unknown = await request("unknown.tool");
    assert.equal(unknown.body?.result, undefined);
    assert.ok(unknown.body?.error);
  });
  test(`${version}: native resources and prompts are public, complete and validated`, async () => {
    const invoiceCount = invoices.size;
    const request = async (
      method: string,
      params: Record<string, unknown> = {},
      overrides: Record<string, string | undefined> = {},
    ) => {
      const message = version === MODERN
        ? stateless(method, params)
        : { jsonrpc: "2.0", id: 1, method, params };
      const headers: Record<string, string> = version === MODERN
        ? statelessHeaders(message, overrides)
        : { ...legacyHeaders, ...overrides } as Record<string, string>;
      return post(message, headers);
    };
    const list = await request("resources/list");
    assert.equal(list.response.status, 200);
    assert.equal(list.body?.error, undefined);
    const resources = list.body!.result!.resources;
    assert.equal(resources.length, 3);
    assert.deepEqual(resources.map((r: { uri: string }) => r.uri), [
      "stratigraphy://catalog/overview",
      "stratigraphy://compliance/eu-ai-act-article-12",
      "stratigraphy://security/tool-integrity",
    ]);
    if (version === MODERN) {
      assert.equal(list.body!.result!.ttlMs, 300000);
      assert.equal(list.body!.result!.cacheScope, "public");
    } else {
      assert.equal(list.body!.result!.ttlMs, undefined);
    }
    for (const resource of resources) {
      const { response, body } = await request("resources/read", { uri: resource.uri });
      assert.equal(response.status, 200);
      assert.equal(body?.error, undefined, JSON.stringify(body));
      const content = body!.result!.contents[0];
      assert.equal(content.uri, resource.uri);
      assert.equal(content.mimeType, "application/json");
      const payload = JSON.parse(content.text);
      if (resource.uri.endsWith("/overview")) {
        assert.equal(payload.toolCount, 16);
        assert.equal(payload.batchSettlement.requestHeader, "X-L402-Batch-Size");
        assert.deepEqual(payload.batchSettlement.supportedBatchSizes, [100]);
        assert.equal(payload.batchSettlement.invoiceGeneratedByDiscovery, false);
        assert.equal(Object.keys(payload.namespaces).length, 5);
        assert.equal(Object.values(payload.namespaces).flat().length, 16);
        assert.ok(payload.dataset);
        assert.match(payload.l402.instructions, /402/);
        assert.match(payload.nip98.instructions, /27235/);
      } else if (resource.uri.includes("/compliance/")) {
        assert.equal(payload.controlMapping.length, 3);
        assert.equal(payload.licensing.annualPriceUsd, 250000);
        assert.equal(payload.licensing.contact, "licensing@bitcoinstratigraphy.com");
        assert.ok(payload.regulations.includes("EU AI Act Article 26(6)"));
      } else {
        const manifest = await (await fetch(`${baseUrl}/.well-known/integrity.json`)).json();
        assert.deepEqual(payload, manifest);
        assert.equal(payload.tools.length, 16);
        for (const tool of mcpToolDefinitions) {
          const signed = payload.tools.find((entry: { name: string }) => entry.name === tool.name);
          const digest = createHash("sha256").update(tool.description, "utf8").digest();
          assert.equal(signed.description_hash, digest.toString("hex"));
          assert.ok(verify(null, digest, createPublicKey(payload.server_public_key), Buffer.from(signed.signature, "base64")));
        }
      }
      assert.equal(body!.result!.ttlMs, version === MODERN ? 300000 : undefined);
      assert.equal(body!.result!.cacheScope, version === MODERN ? "public" : undefined);
    }
    const promptList = await request("prompts/list");
    assert.equal(promptList.response.status, 200);
    const prompts = promptList.body!.result!.prompts;
    assert.deepEqual(prompts.map((p: { name: string }) => p.name), [
      "ground_agent_reasoning", "audit_thermodynamic_trajectory", "evaluate_enterprise_compliance",
    ]);
    assert.deepEqual(prompts[0].arguments.map((a: { required: boolean }) => a.required), [true, false]);
    assert.deepEqual(prompts[1].arguments.map((a: { required: boolean }) => a.required), [true, true]);
    assert.equal(promptList.body!.result!.ttlMs, version === MODERN ? 300000 : undefined);
    const examples = [
      ["ground_agent_reasoning", { claim: "A telemetry claim", targetHeightOrDate: "920000" }, /proof\.ground.*stratigraphy\.get|stratigraphy\.get.*proof\.ground/],
      ["audit_thermodynamic_trajectory", { fromTarget: "2026-10-12", toTarget: "latest" }, /workflow\.audit_trajectory.*proof\.verify/s],
      ["evaluate_enterprise_compliance", { organizationName: "Example Corp", swarmSize: "12" }, /NIP-98.*proof\.attenuate/s],
    ] as const;
    for (const [name, args, pattern] of examples) {
      const { response, body } = await request("prompts/get", { name, arguments: args }, { "Mcp-Name": name });
      assert.equal(response.status, 200);
      assert.equal(body?.error, undefined, JSON.stringify(body));
      const messages = body!.result!.messages;
      assert.match(JSON.stringify(messages), pattern);
      assert.equal(body!.result!.cacheScope, undefined, "argument-specific prompts are not publicly cached");
      if (name === "evaluate_enterprise_compliance") {
        assert.equal(messages[0].content.type, "resource");
        assert.equal(messages[0].content.resource.uri, resources[1].uri);
        assert.ok(JSON.parse(messages[0].content.resource.text).licensing);
      }
    }
    const defaultGround = await request("prompts/get", { name: "ground_agent_reasoning", arguments: { claim: "Test claim" } });
    assert.equal(defaultGround.body?.error, undefined);
    assert.match(JSON.stringify(defaultGround.body?.result), /latest/);
    const defaultPlan = await request("prompts/get", { name: "evaluate_enterprise_compliance" });
    assert.equal(defaultPlan.body?.error, undefined);
    const invalidCases: [string, Record<string, unknown>][] = [
      ["resources/read", { uri: "stratigraphy://unknown" }],
      ["resources/read", {}],
      ["prompts/get", { name: "unknown" }],
      ["prompts/get", { name: "ground_agent_reasoning" }],
      ["prompts/get", { name: "ground_agent_reasoning", arguments: { claim: "  " } }],
      ["prompts/get", { name: "ground_agent_reasoning", arguments: { claim: 12 } }],
      ["prompts/get", { name: "audit_thermodynamic_trajectory", arguments: { fromTarget: "920000" } }],
      ["prompts/get", { name: "audit_thermodynamic_trajectory", arguments: { fromTarget: "2026-02-30", toTarget: "latest" } }],
      ["prompts/get", { name: "evaluate_enterprise_compliance", arguments: { swarmSize: "-1" } }],
      ["prompts/get", { name: "evaluate_enterprise_compliance", arguments: { unexpected: "argument" } }],
    ];
    for (const [method, params] of invalidCases) {
      const { body } = await request(method, params);
      assert.equal(body?.error?.code, -32602, JSON.stringify({ method, params, body }));
      assertStrictError(body, -32602);
    }
    for (const [method, params] of [
      ["prompts/get", { name: "evaluate_enterprise_compliance" }],
      ["resources/read", { uri: resources[0].uri }],
    ] as const) {
      const mismatch = await request(method, params, { "Mcp-Name": "wrong-name", "Mcp-Method": method });
      assertStrictError(mismatch.body, MCP_HEADER_MISMATCH);
    }
    assert.equal(invoices.size, invoiceCount, "discovery must never issue invoices");
    const tools = await request("tools/list");
    assert.equal(tools.body?.result?.tools.length, 16, "native discovery does not add tools");
  });
}
