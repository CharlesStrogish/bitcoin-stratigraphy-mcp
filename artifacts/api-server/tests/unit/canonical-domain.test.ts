import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import test from "node:test";
import express from "express";
import { redirectLegacyDomain } from "../../src/middleware/canonicalDomain";

function post(origin: string, host: string, body = "") {
  return new Promise<{ status: number | undefined; location: string | undefined; body: string }>((resolve, reject) => {
    const req = request(origin + "/api/mcp?trace=a%2Fb&x=1", {
      method: "POST",
      headers: { Host: host, "Content-Type": "application/json", "X-Forwarded-Host": "old.replit.app" },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("legacy Host redirects precede JSON parsing and all API execution", async (t) => {
  const app = express();
  let executed = 0;
  app.use(redirectLegacyDomain);
  app.use(express.json());
  app.use((_req, res) => { executed += 1; res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const host of ["old.replit.app", "old.replit.dev:443", "old.repl.co", "REPLIT.APP."]) {
    const result = await post(origin, host, "invalid JSON");
    assert.equal(result.status, 301);
    assert.equal(result.location, "https://bitcoinstratigraphy.com/api/mcp?trace=a%2Fb&x=1");
    assert.equal(result.body, "");
  }
  assert.equal(executed, 0);
  for (const host of ["localhost", "127.0.0.1:5000", "[::1]:5000",
    "bitcoinstratigraphy.com", "www.bitcoinstratigraphy.com",
    "old.replit.app.evil.example", "notreplit.app"]) {
    const result = await post(origin, host, "{}");
    assert.equal(result.status, 200, host);
    assert.equal(result.location, undefined);
  }
  assert.equal(executed, 7);
});
