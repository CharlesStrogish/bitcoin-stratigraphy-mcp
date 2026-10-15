import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import test from "node:test";
import express, { type Express, type Request, type Response } from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import {
  createClientChainCheck,
  resolveClientAddress,
  type ClientChainSummary,
} from "../../src/lib/client-address";
import { requestLogHooks } from "../../src/lib/request-log";
import {
  clientReference,
  createPublicRateLimiter,
  createPublicRateLimitMiddleware,
  createPublicWebRateLimitMiddleware,
  createSlidingWindowRateLimiter,
  rateLimitIpKey,
} from "../../src/middleware/rateLimiter";

async function serve(app: Express, run: (url: string) => Promise<void>) {
  const server = app.listen(0);
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

const strictLimiter = () =>
  createSlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 });

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

test("client resolution follows the Google layout only behind a trusted front end", () => {
  const resolve = (
    forwarded: string | undefined,
    ip: string,
    peer = "10.0.0.1",
  ) =>
    resolveClientAddress({
      headers: forwarded ? { "x-forwarded-for": forwarded } : {},
      ip,
      socket: { remoteAddress: peer },
    } as unknown as Request);
  // "[caller-supplied…], client, load balancer, front end"; Express already
  // accepted the front end from the trusted router.
  assert.deepEqual(
    resolve("203.0.113.9, 198.51.100.7, 34.111.0.1, 35.191.4.2", "35.191.4.2"),
    { address: "198.51.100.7", source: "load-balancer" },
  );
  assert.deepEqual(
    resolve("[2001:db8::1]:443, 34.111.0.1, 130.211.0.9", "130.211.0.9"),
    { address: "2001:db8:0:0:0:0:0:1", source: "load-balancer" },
  );
  // Untrusted peers: Express reports the socket, so the header is ignored.
  assert.deepEqual(
    resolve("198.51.100.7, 34.111.0.1, 35.191.4.2", "10.0.0.1"),
    { address: "10.0.0.1", source: "direct" },
  );
  // Other proxies, malformed client entries and short chains keep Express's answer.
  assert.deepEqual(resolve("198.51.100.7, 203.0.113.5", "203.0.113.5"), {
    address: "203.0.113.5",
    source: "forwarded",
  });
  assert.deepEqual(resolve("not-an-ip, 34.111.0.1, 35.191.4.2", "35.191.4.2"), {
    address: "35.191.4.2",
    source: "forwarded",
  });
  assert.deepEqual(resolve("198.51.100.7, 35.191.4.2", "35.191.4.2"), {
    address: "35.191.4.2",
    source: "forwarded",
  });
  // Loopback without forwarding headers is the platform probe shape.
  assert.deepEqual(resolve(undefined, "::ffff:127.0.0.1", "::ffff:127.0.0.1"), {
    address: "127.0.0.1",
    source: "loopback",
  });
});

test("Google load-balancer chains share one budget per client despite rotating front ends", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    createPublicRateLimitMiddleware(
      createSlidingWindowRateLimiter({ limit: 5, windowMs: 60_000 }),
      { exemptPlatformProbes: false },
    ),
  );
  app.get("/", (_req, res) => res.json({ ok: true }));
  const chain = (client: string, index: number) =>
    `203.0.113.${index}, ${client}, 34.111.0.1, 35.191.${index}.${index + 1}`;
  const status = async (url: string, forwarded: string) =>
    (await fetch(url, { headers: { "X-Forwarded-For": forwarded } })).status;
  await serve(app, async (url) => {
    for (let index = 0; index < 5; index++) {
      assert.equal(await status(url, chain("198.51.100.20", index)), 200);
    }
    // New front ends and new caller-supplied prefixes do not reset the budget.
    assert.equal(await status(url, chain("198.51.100.20", 9)), 429);
    assert.equal(
      await status(url, "198.51.100.20, 34.111.0.1, 130.211.2.7"),
      429,
    );
    assert.equal(await status(url, chain("198.51.100.21", 10)), 200);
  });
});

test("published deployments exempt loopback probe reads without forwarding headers", async () => {
  const previous = process.env.REPLIT_DEPLOYMENT;
  process.env.REPLIT_DEPLOYMENT = "1";
  const deployed = createPublicWebRateLimitMiddleware(strictLimiter());
  delete process.env.REPLIT_DEPLOYMENT;
  const workspace = createPublicWebRateLimitMiddleware(strictLimiter());
  if (previous !== undefined) process.env.REPLIT_DEPLOYMENT = previous;
  const app = express();
  app.set("trust proxy", 1);
  app.use("/deployed", deployed);
  app.use("/workspace", workspace);
  app.all(/.*/, (_req, res) => res.json({ ok: true }));
  await serve(app, async (url) => {
    // Startup and five-minute probes: repeated GET/HEAD across service paths.
    const paths = [
      "/",
      "/api/healthz",
      "/.well-known/mcp/server-card.json",
      "/docs",
    ];
    for (let index = 0; index < 24; index++) {
      const path = paths[index % paths.length]!;
      const response = await fetch(`${url}/deployed${path}`, {
        method: index % 2 ? "HEAD" : "GET",
      });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.has("ratelimit-limit"), false, path);
    }
    // Loopback writes and forwarded external traffic keep their budgets.
    const write = `${url}/deployed/api/v1/macaroon/attenuate`;
    assert.equal((await fetch(write, { method: "POST" })).status, 200);
    assert.equal((await fetch(write, { method: "POST" })).status, 429);
    const headers = { "X-Forwarded-For": "198.51.100.70" };
    assert.equal(
      (await fetch(`${url}/deployed/docs`, { headers })).status,
      200,
    );
    assert.equal(
      (await fetch(`${url}/deployed/docs`, { headers })).status,
      429,
    );
    // Outside a published deployment, loopback reads are limited like any client.
    assert.equal((await fetch(`${url}/workspace/docs`)).status, 200);
    assert.equal((await fetch(`${url}/workspace/docs`)).status, 429);
  });
});

test("paid escrow routes and L402 retries never spend the free budget", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    createPublicWebRateLimitMiddleware(strictLimiter(), {
      exemptPlatformProbes: false,
    }),
  );
  app.all(/.*/, (_req, res) => res.json({ ok: true }));
  const headers = {
    "X-Forwarded-For": "198.51.100.50",
    Authorization: `L402 bWFjYXJvb24:${"0".repeat(64)}`,
  };
  await serve(app, async (url) => {
    assert.equal(
      (await fetch(`${url}/api/v1/escrow/stats`, { headers })).status,
      200,
    );
    assert.equal(
      (await fetch(`${url}/api/v1/escrow/stats`, { headers })).status,
      429,
    );
    for (const [method, path] of [
      ["POST", "/api/v1/escrow/create"],
      ["POST", "/api/v1/escrow/settle/"],
      ["GET", "/api/v1/escrow/receipt/esc_0001"],
      ["HEAD", "/api/v1/escrow/receipt/esc_0001"],
      ["GET", "/api/v1/stratigraphy/l402"],
    ] as const) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(`${url}${path}`, { method, headers });
        assert.equal(response.status, 200, `${method} ${path}`);
        assert.equal(response.headers.has("ratelimit-limit"), false);
      }
    }
    // Credential headers alone never exempt free calls.
    for (const [method, path] of [
      ["GET", "/api/v1/escrow/toll"],
      ["POST", "/api/v1/macaroon/attenuate"],
      ["GET", "/api/v1/escrow/create"],
      ["POST", "/api/v1/escrow/receipt/esc_0001"],
      ["GET", "/api/v1/escrow/receipt/esc_0001/extra"],
    ] as const) {
      const response = await fetch(`${url}${path}`, { method, headers });
      assert.equal(response.status, 429, `${method} ${path}`);
    }
  });
});

test("refusals log at warn with a per-boot client reference, never the address", async () => {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n")) {
        if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const app = express();
  app.set("trust proxy", 1);
  app.use(pinoHttp({ logger: pino(destination), ...requestLogHooks }));
  app.use(
    createPublicRateLimitMiddleware(strictLimiter(), {
      exemptPlatformProbes: false,
    }),
  );
  app.get("/", (_req, res) => res.json({ ok: true }));
  const headers = { "X-Forwarded-For": "198.51.100.60" };
  await serve(app, async (url) => {
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal((await fetch(url, { headers })).status, 429);
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [completed, refused] = lines;
  assert.equal(completed?.level, 30);
  assert.equal(completed?.msg, "request completed");
  assert.equal(completed !== undefined && "rateLimit" in completed, false);
  assert.equal(refused?.level, 40);
  assert.equal(refused?.msg, "request rate limited");
  const refusal = refused?.rateLimit as Record<string, unknown>;
  assert.deepEqual(refusal, {
    limiter: "public",
    retryAfterSeconds: 60,
    clientRef: clientReference("198.51.100.60"),
    clientSource: "forwarded",
  });
  assert.match(String(refusal.clientRef), /^[0-9a-f]{12}$/);
  assert.notEqual(refusal.clientRef, clientReference("198.51.100.61"));
  assert.equal(JSON.stringify(refusal).includes("198.51.100"), false);
});

test("the one-time chain check reports Google's layout from counts only", () => {
  const run = (
    check: ReturnType<typeof createClientChainCheck>,
    forwarded: string,
    ip: string,
  ) =>
    check(
      { headers: { "x-forwarded-for": forwarded }, ip } as unknown as Request,
      {} as Response,
      () => {},
    );
  const confirmed: ClientChainSummary[] = [];
  const check = createClientChainCheck((summary) => confirmed.push(summary));
  for (let index = 0; index < 9; index++) {
    run(
      check,
      `198.51.100.${index}, 34.111.0.1, 35.191.0.${index}`,
      `35.191.0.${index}`,
    );
  }
  assert.deepEqual(confirmed, [
    {
      layout: "confirmed",
      samples: 8,
      shortChains: 0,
      distinctClients: 8,
      distinctLoadBalancers: 1,
    },
  ]);
  const unexpected: ClientChainSummary[] = [];
  const short = createClientChainCheck((summary) => unexpected.push(summary));
  run(short, "198.51.100.1, 35.191.0.1", "35.191.0.1");
  assert.equal(unexpected[0]?.layout, "unexpected");
  assert.equal(unexpected[0]?.shortChains, 1);
  const varying: ClientChainSummary[] = [];
  const wide = createClientChainCheck((summary) => varying.push(summary));
  for (let index = 0; index < 5; index++) {
    run(wide, `198.51.100.1, 34.111.0.${index}, 35.191.0.1`, "35.191.0.1");
  }
  assert.equal(varying[0]?.layout, "unexpected");
  assert.equal(varying[0]?.distinctLoadBalancers, 5);
  // Requests that did not arrive through a trusted Google front end are ignored.
  const ignored: ClientChainSummary[] = [];
  const untrusted = createClientChainCheck((summary) => ignored.push(summary), {
    maxSamples: 1,
  });
  run(untrusted, "198.51.100.1, 34.111.0.1, 35.191.0.1", "127.0.0.1");
  assert.deepEqual(ignored, []);
});
