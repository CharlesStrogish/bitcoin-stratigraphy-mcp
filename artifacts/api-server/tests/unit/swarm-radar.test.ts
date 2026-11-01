import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import type { Request, Response } from "express";
import { createSwarmRadar } from "../../src/middleware/swarmRadar";
import { apiRootAliases } from "../../src/middleware/apiRootAliases";

function request(path: string, agent = "Mozilla/5.0"): Request {
  return {
    path,
    url: path,
    originalUrl: `${path}?preimage=do-not-log`,
    ip: "192.0.2.1",
    get: (name: string) => name.toLowerCase() === "user-agent" ? agent : "do-not-log",
    get body() { throw new Error("Telemetry must not read request bodies"); },
  } as unknown as Request;
}

test("radar detects every discovery path and advances synchronously before logging", async () => {
  for (const path of [
    "/openapi.json", "/.well-known/ai-plugin.json",
    "/.well-known/mcp-configuration.json", "/robots.txt", "/sitemap.xml",
    "/yield-proofs.json", "/OPENAPI.JSON/",
  ]) {
    const events: unknown[] = [];
    let advances = 0;
    const req = request(path);
    const res = new Proxy({} as Response, {
      get() { throw new Error("Telemetry must not touch the response"); },
      set() { throw new Error("Telemetry must not touch the response"); },
    });
    createSwarmRadar(event => { events.push(event); })(req, res, () => { advances++; });
    assert.equal(advances, 1);
    assert.equal(events.length, 0);
    await tick();
    assert.deepEqual(events, [{
      event: "swarm_radar", route: path, ip: "192.0.2.1", agent: "Mozilla/5.0",
    }]);
    assert.equal(req.originalUrl, `${path}?preimage=do-not-log`);
  }
});

test("radar detects all six case-insensitive AI signatures on payment paths", async () => {
  for (const signature of ["gPtBoT", "ClaudeBot", "Anthropic", "axios", "node-fetch", "python-requests"]) {
    const events: unknown[] = [];
    let advances = 0;
    createSwarmRadar(event => { events.push(event); })(
      request("/api/v1/stratigraphy", `client ${signature}/1.0`),
      {} as Response,
      () => { advances++; },
    );
    assert.equal(advances, 1);
    assert.equal(events.length, 0);
    await tick();
    assert.equal(events.length, 1);
  }
});

test("radar ignores normal traffic and discovery lookalikes, including missing agents", async () => {
  const events: unknown[] = [];
  const radar = createSwarmRadar(event => { events.push(event); });
  let advances = 0;
  for (const path of ["/api/v1/stratigraphy", "/openapi.jsonx", "/yield-proofs.json/private"]) {
    radar(request(path, ""), {} as Response, () => { advances++; });
  }
  await tick();
  assert.equal(advances, 3);
  assert.deepEqual(events, []);
});

test("radar bounds and sanitizes untrusted metadata and tolerates a failing logger", async () => {
  const events: Array<{ agent: string }> = [];
  let advances = 0;
  const req = request("/openapi.json", "GPTBot\r\nforged-log\u001b" + "x".repeat(2000));
  createSwarmRadar(event => { events.push(event); })(req, {} as Response, () => { advances++; });
  createSwarmRadar(() => { throw new Error("Logger unavailable"); })(req, {} as Response, () => { advances++; });
  createSwarmRadar()(new Proxy(req, { get() { throw new Error("Invalid metadata"); } }), {} as Response, () => { advances++; });
  assert.equal(advances, 3);
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].agent.length, 512);
  assert.doesNotMatch(events[0].agent, /[\r\n\u001b]/);
});

test("radar sees normalized discovery aliases without rewriting the original URL", async () => {
  const events: Array<{ route: string }> = [];
  const req = request("/api/yield-proofs.json");
  Object.defineProperty(req, "path", { get: () => req.url.split("?")[0] });
  apiRootAliases(req, {} as Response, () => {});
  createSwarmRadar(event => { events.push(event); })(req, {} as Response, () => {});
  await tick();
  assert.equal(events[0].route, "/yield-proofs.json");
  assert.equal(req.originalUrl, "/api/yield-proofs.json?preimage=do-not-log");
});
