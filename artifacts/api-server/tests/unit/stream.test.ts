import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import { createMemoryPaymentChallengeStore } from "../../src/lib/payment-challenge-store";
import { createSubscriptionMacaroon } from "../../src/lib/subscription-pass";
import { registerStratigraphyRoutes } from "../../src/routes/stratigraphy";
import type {
  IntervalScheduler,
  StratigraphyTelemetry,
  StratigraphyTelemetryHub,
} from "../../src/services/stratigraphy-stream";
import { readLiveBitcoinTelemetry } from "../../src/services/stratigraphy-stream";
import type {
  SettlementRouter,
} from "../../src/services/settlement";
import { createAgentReputationService } from "../../src/services/agentReputation";

const vipAgentKey = generateSecretKey();
const vipAgentPubkey = getPublicKey(vipAgentKey);
const vipAgentReputation = createAgentReputationService({
  tiers: { [vipAgentPubkey]: "VIP" },
});

const telemetry: StratigraphyTelemetry = {
  observed_at: "2026-09-16T12:00:00.000Z",
  block: { height: 920_000 },
  difficulty: {
    epoch_progress_percent: 42.5,
    estimated_adjustment_percent: 1.25,
  },
  market: {
    usd_per_btc: 100_000,
    sats_per_usd: 1_000,
  },
  thermodynamic: {
    signal: "elevated-target-distance",
    target_multiplier: 110,
  },
};

function createTestHub() {
  const listeners = new Set<(value: StratigraphyTelemetry) => void>();
  let cleanupCalls = 0;
  const hub: StratigraphyTelemetryHub = {
    subscribe(listener) {
      listeners.add(listener);
      listener(telemetry);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        cleanupCalls += 1;
        listeners.delete(listener);
      };
    },
    activeSubscribers: () => listeners.size,
  };
  return {
    hub,
    cleanupCalls: () => cleanupCalls,
  };
}

function createTestScheduler() {
  const intervals = new Map<
    object,
    { callback: () => void; delayMs: number }
  >();
  let clearCalls = 0;
  const scheduler: IntervalScheduler = {
    setInterval(callback, delayMs) {
      const handle = {};
      intervals.set(handle, { callback, delayMs });
      return handle;
    },
    clearInterval(handle) {
      clearCalls += 1;
      intervals.delete(handle as object);
    },
  };
  return {
    scheduler,
    intervals,
    clearCalls: () => clearCalls,
  };
}

function createRouter(
  verifyPayment?: SettlementRouter["verifyPayment"],
): SettlementRouter {
  let invoiceSequence = 0;
  return {
    isConfigured: () => true,
    activeProvider: () => "coinos",
    circuitState: () => "closed",
    async createInvoice() {
      invoiceSequence += 1;
      return {
        invoice: `lnbc-stream-${invoiceSequence}`,
        paymentHash: invoiceSequence.toString(16).padStart(64, "0"),
        provider: "coinos",
      };
    },
    verifyPayment:
      verifyPayment ??
      (async (input) => {
        const paymentHash = createHash("sha256")
          .update(Buffer.from(input.preimage, "hex"))
          .digest("hex");
        return paymentHash === input.paymentHash
          ? {
              settledAt: Math.floor(Date.now() / 1000),
              provider: "coinos",
            }
          : "invalid";
      }),
  };
}

async function withStreamServer(
  run: (input: {
    url: string;
    hubState: ReturnType<typeof createTestHub>;
    schedulerState: ReturnType<typeof createTestScheduler>;
  }) => Promise<void>,
  router: SettlementRouter = createRouter(),
) {
  const hubState = createTestHub();
  const schedulerState = createTestScheduler();
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = {
      error: () => undefined,
      warn: () => undefined,
    };
    next();
  });
  registerStratigraphyRoutes(
    app,
    undefined,
    {
      now: Date.now,
      reuseMs: 5 * 60 * 1000,
      limitWindowMs: 60 * 60 * 1000,
      maxInvoicesPerWindow: 100,
      maxCallers: 10_000,
    },
    createMemoryPaymentChallengeStore(),
    undefined,
    undefined,
    undefined,
    router,
    {
      telemetryHub: hubState.hub,
      heartbeatScheduler: schedulerState.scheduler,
      agentReputation: vipAgentReputation,
    },
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run({
      url: `http://127.0.0.1:${address.port}/api/v1/stratigraphy/stream`,
      hubState,
      schedulerState,
    });
  } finally {
    server.close();
  }
}

function streamAuthorization() {
  const secret = process.env.SESSION_SECRET!;
  const preimage = "b".repeat(64);
  const paymentHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
  const macaroon = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
  });
  return `L402 ${macaroon}:${preimage}`;
}

function boundStreamAuthorization(url: string) {
  const secret = process.env.SESSION_SECRET!;
  const preimage = "b".repeat(64);
  const paymentHash = createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");
  const macaroon = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
    agentIdentity: vipAgentReputation.identityForPubkey(vipAgentPubkey),
  });
  const event = finalizeEvent(
    {
      kind: 27_235,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
      content: "",
    },
    vipAgentKey,
  );
  return {
    l402: `L402 ${macaroon}:${preimage}`,
    nip98: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
) {
  const decoder = new TextDecoder();
  let content = "";
  while (!content.includes(expected)) {
    const result = await reader.read();
    if (result.done) break;
    content += decoder.decode(result.value, { stream: true });
  }
  return content;
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for stream cleanup");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("returns an L402 challenge before opening an unauthenticated stream", async () => {
  await withStreamServer(async ({ url, hubState, schedulerState }) => {
    const response = await fetch(url);
    assert.equal(response.status, 402);
    assert.match(response.headers.get("www-authenticate") ?? "", /^L402 /);
    assert.equal(
      response.headers.get("content-type")?.startsWith("application/json"),
      true,
    );
    assert.equal(hubState.hub.activeSubscribers(), 0);
    assert.equal(schedulerState.intervals.size, 0);
  });
});

test("opens an authenticated SSE stream and sends telemetry JSON", async () => {
  await withStreamServer(async ({ url }) => {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { Authorization: streamAuthorization() },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("connection"), "keep-alive");
    const reader = response.body!.getReader();
    const content = await readUntil(reader, "\n\n");
    assert.match(content, /event: telemetry/);
    const payload = JSON.parse(
      content.split("data: ")[1].split("\n\n")[0],
    );
    const { attestation, ...unsignedTelemetry } = payload;
    assert.deepEqual(unsignedTelemetry, telemetry);
    assert.deepEqual(JSON.parse(attestation.event.content), telemetry);
    assert.equal(verifyEvent(attestation.event), true);
    await reader.cancel();
    controller.abort();
  });
});

test("opens an agent-bound SSE stream with matching NIP-98 identity", async () => {
  await withStreamServer(async ({ url }) => {
    const authorization = boundStreamAuthorization(url);
    const response = await fetch(url, {
      headers: {
        Authorization: authorization.l402,
        "X-Nostr-Authorization": authorization.nip98,
      },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const content = await readUntil(reader, "\n\n");
    assert.match(content, /event: telemetry/);
    await reader.cancel();
  });
});

test("rejects a macaroon paired with the wrong payment preimage", async () => {
  await withStreamServer(async ({ url, hubState, schedulerState }) => {
    const authorization = streamAuthorization().replace(
      /:[0-9a-f]{64}$/,
      `:${"c".repeat(64)}`,
    );
    const response = await fetch(url, {
      headers: { Authorization: authorization },
    });
    assert.equal(response.status, 402);
    assert.equal(hubState.hub.activeSubscribers(), 0);
    assert.equal(schedulerState.intervals.size, 0);
  });
});

test("emits JSON ping heartbeats every 15 seconds", async () => {
  await withStreamServer(async ({ url, schedulerState }) => {
    const response = await fetch(url, {
      headers: { Authorization: streamAuthorization() },
    });
    const reader = response.body!.getReader();
    await readUntil(reader, "\n\n");
    const heartbeat = [...schedulerState.intervals.values()][0];
    assert.equal(heartbeat.delayMs, 15_000);
    heartbeat.callback();
    const content = await readUntil(reader, "\n\n");
    assert.match(content, /event: ping/);
    const payload = JSON.parse(content.split("data: ")[1].split("\n\n")[0]);
    assert.equal(typeof payload.observed_at, "string");
    const { attestation, ...unsignedPing } = payload;
    assert.deepEqual(JSON.parse(attestation.event.content), unsignedPing);
    assert.equal(
      createHash("sha256")
        .update(attestation.event.content)
        .digest("hex"),
      attestation.payload_sha256,
    );
    assert.equal(attestation.event.kind, 30078);
    assert.equal(verifyEvent(attestation.event), true);
    await reader.cancel();
  });
});

test("cleans telemetry listeners and heartbeat timers on disconnect", async () => {
  await withStreamServer(async ({ url, hubState, schedulerState }) => {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { Authorization: streamAuthorization() },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await readUntil(reader, "\n\n");
    assert.equal(hubState.hub.activeSubscribers(), 1);
    assert.equal(schedulerState.intervals.size, 1);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await waitFor(
      () =>
        hubState.hub.activeSubscribers() === 0 &&
        schedulerState.intervals.size === 0,
    );
    assert.equal(hubState.cleanupCalls(), 1);
    assert.equal(schedulerState.clearCalls(), 1);
  });
});

test("does not attach stream resources after disconnect during verification", async () => {
  let verificationStarted!: () => void;
  let verificationAborted = false;
  const started = new Promise<void>((resolve) => {
    verificationStarted = resolve;
  });
  const router = createRouter(async (input) => {
    verificationStarted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        verificationAborted = true;
        reject(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (input.signal?.aborted) {
        abort();
        return;
      }
      input.signal?.addEventListener("abort", abort, { once: true });
      void resolve;
    });
  });
  await withStreamServer(
    async ({ url, hubState, schedulerState }) => {
      const controller = new AbortController();
      const request = fetch(url, {
        headers: { Authorization: streamAuthorization() },
        signal: controller.signal,
      });
      await started;
      controller.abort();
      await request.catch(() => undefined);
      await waitFor(() => verificationAborted);
      assert.equal(hubState.hub.activeSubscribers(), 0);
      assert.equal(schedulerState.intervals.size, 0);
      assert.equal(verificationAborted, true);
      assert.equal(hubState.cleanupCalls(), 0);
      assert.equal(schedulerState.clearCalls(), 0);
    },
    router,
  );
});

test("cancels non-success telemetry response bodies", async () => {
  const originalFetch = globalThis.fetch;
  let cancelCalls = 0;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelCalls += 1;
        },
      }),
      { status: 503 },
    );
  try {
    const result = await readLiveBitcoinTelemetry({
      epochProgressPercent: 50,
      thermodynamicSignal: "elevated-target-distance",
      targetMultiplier: 100,
    });
    assert.equal(result.block.height, null);
    assert.equal(result.market.usd_per_btc, null);
    assert.equal(result.difficulty.estimated_adjustment_percent, null);
    assert.equal(cancelCalls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});