import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type Request } from "express";
import {
  createPublicRateLimiter,
  createPublicRateLimitMiddleware,
  createPublicWebRateLimitMiddleware,
  createSlidingWindowRateLimiter,
  rateLimitIpKey,
} from "../../src/middleware/rateLimiter";

test("public budget shares routes, is per IP, and expires after 15 minutes", async () => {
  let now = 0;
  const limiter = createSlidingWindowRateLimiter({
    limit: 100,
    windowMs: 900_000,
    now: () => now,
  });
  const app = express();
  app.set("trust proxy", 1);
  app.use(createPublicWebRateLimitMiddleware(limiter));
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { "X-Forwarded-For": "198.51.100.8" };
  try {
    for (let index = 0; index < 100; index++) {
      assert.equal(
        (
          await fetch(`${url}/${index % 2 ? "docs" : "api/healthz"}`, {
            headers,
          })
        ).status,
        200,
      );
    }
    const blocked = await fetch(`${url}/.well-known/mcp/server-card.json`, {
      headers,
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "900");
    assert.equal(blocked.headers.get("ratelimit-limit"), "100");
    assert.equal(blocked.headers.get("ratelimit-remaining"), "0");
    assert.equal(blocked.headers.get("ratelimit-policy"), "100;w=900");
    assert.equal(
      (
        await fetch(`${url}/docs`, {
          headers: { "X-Forwarded-For": "198.51.100.9" },
        })
      ).status,
      200,
    );
    // Paid routes retain their original policies, not the public limiter.
    for (const path of [
      "/mcp",
      "/MCP/",
      "/api/v1/stratigraphy",
      "/api/v1/zk/ground",
    ]) {
      const response = await fetch(`${url}${path}`, { headers });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.has("ratelimit-limit"), false);
    }
    now = 900_000;
    assert.equal((await fetch(`${url}/docs`, { headers })).status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("capacity cannot evict an active budget; expired keys are reclaimed", () => {
  const limiter = createSlidingWindowRateLimiter({
    limit: 1,
    windowMs: 900_000,
    maxKeys: 2,
  });
  assert.equal(limiter.check("first", 0).allowed, true);
  assert.equal(limiter.check("second", 0).allowed, true);
  for (let index = 0; index < 100; index++)
    assert.equal(limiter.check(`rotating-${index}`, 1).allowed, false);
  assert.equal(limiter.check("first", 1).allowed, false);
  assert.equal(limiter.check("third", 900_000).allowed, true);
  limiter.reset();
  assert.equal(limiter.check("third", 900_001).allowed, true);
});

test("IPv6 equivalent spellings and /64 rotation share one budget; IPv4 stays independent", () => {
  const key = (ip: string) => rateLimitIpKey({ ip } as Request);
  assert.equal(key("2001:0db8:abcd:0001::1"), key("2001:db8:abcd:1::ffff"));
  assert.notEqual(key("2001:db8:abcd:1::1"), key("2001:db8:abcd:2::1"));
  assert.equal(key("::ffff:192.0.2.1"), key("192.0.2.1"));
  assert.equal(key("::ffff:c000:201"), key("192.0.2.1"));
  assert.equal(key("fe80::1%eth0"), key("fe80::2%eth1"));
  assert.notEqual(key("192.0.2.1"), key("192.0.2.2"));
});

test("untrusted spoofed forwarding headers do not select a new budget", async () => {
  const app = express();
  app.use(createPublicRateLimitMiddleware(createPublicRateLimiter()));
  app.get("/", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    for (let index = 0; index < 100; index++) {
      assert.equal(
        (
          await fetch(url, {
            headers: { "X-Forwarded-For": `198.51.100.${index}` },
          })
        ).status,
        200,
      );
    }
    assert.equal(
      (await fetch(url, { headers: { "X-Forwarded-For": "203.0.113.1" } }))
        .status,
      429,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
