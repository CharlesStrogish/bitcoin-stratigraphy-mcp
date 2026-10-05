import test from "node:test";
import assert from "node:assert/strict";
import { freeSandbox } from "../examples/free-sandbox.mjs";

test("sandbox negotiates MCP and calls exactly two free tools without credentials", async () => {
  const calls = [];
  const result = await freeSandbox(undefined, async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    assert.equal(options.headers.Authorization, undefined);
    if (request.method === "notifications/initialized") return new Response(null, { status: 204 });
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
      : { content: [], structuredContent: { tool: request.params.name } };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  assert.deepEqual(calls.filter(c => c.method === "tools/call").map(c => c.params), [
    { name: "stratigraphy.list", arguments: {} },
    { name: "proof.list", arguments: {} },
  ]);
  assert.deepEqual(Object.keys(result), ["stratigraphy.list", "proof.list"]);
});

test("unexpected 402 fails without paying or retrying", async () => {
  let requests = 0;
  await assert.rejects(freeSandbox(undefined, async () => {
    requests++;
    return new Response(null, { status: 402 });
  }), /no payment attempted/);
  assert.equal(requests, 1);
});

test("credentials in URLs are rejected before connecting", async () => {
  await assert.rejects(freeSandbox("https://user:password@example.com/mcp"), /credential-free/);
});