import assert from "node:assert/strict";

const DEFAULT_BASE_URL =
  "https://bitcoin-stratigraphy-dashboard--charlesstrogish.replit.app";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 30_000;
const EXPECTED_TOOLS = [
  "stratigraphy.get",
  "stratigraphy.list",
  "proof.verify",
  "proof.status",
  "proof.list",
  "proof.submit",
  "mesh.status",
] as const;

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

type McpTool = {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
};

function liveBaseUrl(): URL {
  const value =
    process.env.MCP_BASE_URL ??
    process.env.NOSTR_API_BASE_URL ??
    DEFAULT_BASE_URL;
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "Live MCP base URL must use HTTPS");
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonSchema(
  value: unknown,
  toolName: string,
): asserts value is Record<string, unknown> {
  assert.ok(isRecord(value), `${toolName} inputSchema must be an object`);
  assert.equal(value.type, "object", `${toolName} inputSchema must be an object schema`);
  assert.equal(
    value.additionalProperties,
    false,
    `${toolName} inputSchema must reject unknown arguments`,
  );
  assert.ok(
    isRecord(value.properties),
    `${toolName} inputSchema properties must be an object`,
  );
  assert.ok(
    value.required === undefined || Array.isArray(value.required),
    `${toolName} inputSchema required must be an array when present`,
  );
  const required = (value.required ?? []) as unknown[];
  assert.equal(
    new Set(required).size,
    required.length,
    `${toolName} inputSchema has duplicate required properties`,
  );
  for (const propertyName of required) {
    assert.equal(
      typeof propertyName,
      "string",
      `${toolName} inputSchema required entries must be strings`,
    );
    assert.ok(
      Object.hasOwn(value.properties, propertyName as string),
      `${toolName} requires an undefined property: ${String(propertyName)}`,
    );
  }
  for (const [propertyName, propertySchema] of Object.entries(value.properties)) {
    assert.ok(
      isRecord(propertySchema),
      `${toolName}.${propertyName} schema must be an object`,
    );
    assert.ok(
      typeof propertySchema.type === "string" ||
        (Array.isArray(propertySchema.type) &&
          propertySchema.type.every((type) => typeof type === "string")),
      `${toolName}.${propertyName} schema must declare a valid type`,
    );
  }
}

async function assertHttpHealth(baseUrl: URL) {
  const healthUrl = new URL("/api/v1/health", baseUrl);
  const response = await fetch(healthUrl, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  assert.equal(
    response.status,
    200,
    `Health check failed with HTTP ${response.status}: ${body}`,
  );
  const health = JSON.parse(body) as unknown;
  assert.ok(isRecord(health), "Health response must be a JSON object");
  assert.equal(health.status, "ok", "Health response status must be ok");
  console.log(`HTTP health verified: GET ${healthUrl} returned 200 OK.`);
}

async function mcpRequest(
  baseUrl: URL,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  assert.equal(
    response.status,
    200,
    `MCP ${method} failed with HTTP ${response.status}: ${body}`,
  );
  const payload = JSON.parse(body) as JsonRpcResponse;
  assert.equal(payload.jsonrpc, "2.0", `${method} returned invalid JSON-RPC`);
  assert.equal(payload.id, id, `${method} returned the wrong JSON-RPC id`);
  assert.equal(
    payload.error,
    undefined,
    `${method} returned JSON-RPC error: ${JSON.stringify(payload.error)}`,
  );
  assert.ok(payload.result !== undefined, `${method} returned no result`);
  return payload;
}

async function assertToolList(baseUrl: URL) {
  const response = await mcpRequest(baseUrl, 1, "tools/list");
  assert.ok(isRecord(response.result), "tools/list result must be an object");
  assert.ok(
    Array.isArray(response.result.tools),
    "tools/list result must contain a tools array",
  );
  const tools = response.result.tools as McpTool[];
  assert.equal(tools.length, EXPECTED_TOOLS.length, "Expected exactly 7 MCP tools");

  const names = tools.map((tool) => tool.name);
  assert.deepEqual(
    [...names].sort(),
    [...EXPECTED_TOOLS].sort(),
    "MCP tool names do not match the expected seven tools",
  );
  for (const tool of tools) {
    const toolName = tool.name;
    assert.ok(typeof toolName === "string", "Every MCP tool needs a name");
    assert.equal(
      typeof tool.description,
      "string",
      `${toolName} needs a description`,
    );
    assertJsonSchema(tool.inputSchema, toolName);
  }
  console.log(
    `MCP tools/list verified: ${tools.length} tools with valid exported schemas.`,
  );
}

function sampleBn254Proof(): string {
  return Buffer.from(
    JSON.stringify({
      pi_a: ["1", "2", "1"],
      pi_b: [
        ["1", "2"],
        ["3", "4"],
        ["1", "0"],
      ],
      pi_c: ["5", "6", "1"],
      protocol: "groth16",
      curve: "bn128",
    }),
  ).toString("base64url");
}

async function assertZkVerificationCall(baseUrl: URL) {
  const response = await mcpRequest(baseUrl, 2, "tools/call", {
    name: "proof.verify",
    arguments: {
      proof: sampleBn254Proof(),
      publicInputs: {
        blockHeight: 920000,
        snapshotDigest: "1",
        thermodynamicHash: "1",
        timestamp: 1789776000000,
        valuationSat: 12583,
      },
      verificationKeyId: "sha256:mcp-health-check",
      data: [
        {
          block: { height: 920000 },
          observed_at: "2026-09-19T00:00:00.000Z",
          thermodynamic: { target_multiplier: 125.83 },
        },
      ],
    },
  });
  assert.ok(isRecord(response.result), "tools/call result must be an object");
  assert.notEqual(
    response.result.isError,
    true,
    "proof.verify returned an MCP tool execution error",
  );
  assert.ok(
    isRecord(response.result.structuredContent),
    "proof.verify must return structuredContent",
  );
  const output = response.result.structuredContent;
  assert.equal(typeof output.valid, "boolean", "valid must be a boolean");
  assert.equal(
    typeof output.verifiedAt,
    "string",
    "verifiedAt must be an ISO timestamp",
  );
  assert.ok(
    !Number.isNaN(Date.parse(output.verifiedAt as string)),
    "verifiedAt must be parseable",
  );
  assert.equal(
    typeof output.computationTimeMs,
    "number",
    "computationTimeMs must be a number",
  );
  assert.ok(
    (output.computationTimeMs as number) >= 0,
    "computationTimeMs cannot be negative",
  );
  if (output.error !== undefined) {
    assert.equal(typeof output.error, "string", "error must be a string");
  }
  console.log(
    `Direct proof.verify call verified: valid=${String(output.valid)}, computationTimeMs=${String(output.computationTimeMs)}.`,
  );
}

async function main() {
  const baseUrl = liveBaseUrl();
  console.log(`Checking live MCP server at ${baseUrl.origin}`);
  await assertHttpHealth(baseUrl);
  await assertToolList(baseUrl);
  await assertZkVerificationCall(baseUrl);
  console.log("\nAll live MCP health checks passed.");
}

main().catch((error: unknown) => {
  console.error("\nLive MCP health verification failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});