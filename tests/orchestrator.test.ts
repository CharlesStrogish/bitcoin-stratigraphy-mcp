import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { Event } from "nostr-tools";
import {
  createHttpRateLimitMiddleware,
  createSlidingWindowRateLimiter,
} from "../artifacts/api-server/src/middleware/rateLimiter";
import { calculateJobPrice } from "../artifacts/api-server/src/services/pricing";
import { createAutoHealingRelayPool } from "../artifacts/api-server/src/services/relayPool";

test("sliding-window limiter rejects excess HTTP requests with Retry-After", async () => {
  let now = 1_000;
  const limiter = createSlidingWindowRateLimiter({
    limit: 2,
    windowMs: 10_000,
    now: () => now,
  });
  const app = express();
  app.get(
    "/paid",
    createHttpRateLimitMiddleware(limiter, () => "client-a"),
    (_req, res) => res.status(200).json({ ok: true }),
  );
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/paid`;
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    const rejected = await fetch(url);
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers.get("Retry-After"), "10");
    assert.deepEqual(await rejected.json(), {
      error: "Too many requests",
      code: "rate_limit_exceeded",
      retry_after: 10,
    });
    now += 10_001;
    assert.equal((await fetch(url)).status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("dynamic job pricing scales both base fees above 70% saturation", () => {
  const load = {
    queueLength: 8,
    queueCapacity: 10,
    cpuUtilization: 0.5,
  };
  const stratigraphy = calculateJobPrice("stratigraphy", load, 3);
  const proof = calculateJobPrice("zk-proof", load, 3);
  assert.equal(stratigraphy.basePriceSats, 5);
  assert.equal(proof.basePriceSats, 21);
  assert.ok(stratigraphy.multiplier > 1);
  assert.equal(stratigraphy.multiplier, proof.multiplier);
  assert.ok(stratigraphy.priceSats > 5);
  assert.ok(proof.priceSats > 21);
  assert.equal(
    calculateJobPrice(
      "stratigraphy",
      { queueLength: 7, queueCapacity: 10, cpuUtilization: 0.7 },
      3,
    ).priceSats,
    5,
  );
});

test("relay pool fails over, opens the circuit, and heals after backoff", async () => {
  let now = 1_000;
  let failingRelayHealthy = false;
  const attempts = new Map<string, number>();
  const pool = createAutoHealingRelayPool({
    relays: ["wss://failing.example", "wss://healthy.example"],
    now: () => now,
    failureThreshold: 2,
    baseBackoffMs: 1_000,
    monitorIntervalMs: 60_000,
    async publishRelay(relay) {
      attempts.set(relay, (attempts.get(relay) ?? 0) + 1);
      if (relay.includes("failing") && !failingRelayHealthy) {
        throw new Error("relay unavailable");
      }
    },
    subscribeRelays: () => () => undefined,
    async reconnectRelay(relay) {
      if (relay.includes("failing") && !failingRelayHealthy) {
        throw new Error("reconnect failed");
      }
    },
  });
  const event = {
    id: "event",
    pubkey: "pubkey",
    created_at: 1,
    kind: 1,
    tags: [],
    content: "",
    sig: "sig",
  } as Event;
  try {
    await pool.publish(event);
    await pool.publish(event);
    let failing = pool
      .health()
      .relays.find((relay) => relay.relay.includes("failing"));
    assert.equal(failing?.circuitState, "OPEN");
    assert.equal(pool.health().healthyRelays, 1);

    await pool.publish(event);
    assert.equal(attempts.get("wss://failing.example"), 2);

    failingRelayHealthy = true;
    now += 1_001;
    await pool.publish(event);
    failing = pool
      .health()
      .relays.find((relay) => relay.relay.includes("failing"));
    assert.equal(failing?.circuitState, "CLOSED");
    assert.equal(failing?.consecutiveFailures, 0);
    assert.equal(pool.health().healthyRelays, 2);
  } finally {
    pool.close();
  }
});

test("relay pool retries accepted events on a relay after it heals", async () => {
  let now = 1_000;
  let relayHealthy = false;
  let monitor: (() => void) | undefined;
  const delivered: string[] = [];
  const pool = createAutoHealingRelayPool({
    relays: ["wss://recovering.example", "wss://healthy.example"],
    now: () => now,
    failureThreshold: 1,
    baseBackoffMs: 1_000,
    async publishRelay(relay, event) {
      if (relay.includes("recovering") && !relayHealthy) {
        throw new Error("relay unavailable");
      }
      delivered.push(`${relay}:${event.id}`);
    },
    subscribeRelays: () => () => undefined,
    async reconnectRelay(relay) {
      if (relay.includes("recovering") && !relayHealthy) {
        throw new Error("reconnect failed");
      }
    },
    scheduler: {
      setInterval(callback) {
        monitor = callback;
        return 1;
      },
      clearInterval() {},
    },
  });
  const event = {
    id: "retry-me",
    pubkey: "pubkey",
    created_at: 1,
    kind: 1,
    tags: [],
    content: "",
    sig: "sig",
  } as Event;
  try {
    await pool.publish(event);
    assert.equal(pool.health().queuedEvents, 1);
    assert.deepEqual(delivered, ["wss://healthy.example:retry-me"]);

    relayHealthy = true;
    now += 1_001;
    monitor?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pool.health().queuedEvents, 0);
    assert.ok(delivered.includes("wss://recovering.example:retry-me"));

    relayHealthy = false;
    await pool.publish({ ...event, id: "discard-on-close" });
    assert.equal(pool.health().queuedEvents, 1);
    pool.close();
    assert.equal(pool.health().queuedEvents, 0);
    relayHealthy = true;
    monitor?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      delivered.some((entry) => entry.endsWith(":discard-on-close")),
      true,
      "the healthy relay should receive the event before shutdown",
    );
    assert.equal(
      delivered.filter((entry) => entry.endsWith(":discard-on-close")).length,
      1,
      "shutdown must not flush queued work to the recovering relay",
    );
  } finally {
    pool.close();
  }
});
