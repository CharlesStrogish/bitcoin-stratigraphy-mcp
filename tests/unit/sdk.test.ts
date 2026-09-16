import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BitcoinStratigraphyClient,
  MemoryCredentialStore,
  type CostDiscovery,
  type StratigraphyTelemetry,
} from "../../sdk/typescript/src/index";

const preimage = "ab".repeat(32);
const paymentHash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");
const cost: CostDiscovery = {
  protocol: "L402",
  access_tiers: [
    {
      id: "1-day",
      duration_days: 1,
      price_sats: 7,
      base_price_sats: 5,
      max_price_sats: 15,
      multiplier: 1.4,
    },
  ],
  dynamic_pricing: {
    difficulty_epoch_progress: 50,
    request_velocity_rpm: 1,
    calculated_at: "2026-09-16T12:00:00.000Z",
  },
  legacy_query_pricing: { sats_per_day: 1, minimum_sats: 5 },
  dataset: { days: 422, first_day: 1, last_day: 422, grows_over_time: true },
  mcp_tool: { name: "get_bitcoin_stratigraphy", parameters: {} },
  response_schema: {},
};
const challenge = {
  invoice: "lnbc-legacy",
  payment_hash: "cd".repeat(32),
  passes: [
    {
      tier: "1-day",
      invoice: "lnbc-subscription",
      payment_hash: paymentHash,
      macaroon: "cached-macaroon",
      valid_until: 2_000_000_000,
      price_sats: 7,
    },
  ],
};
const records = [
  {
    day: 422,
    title: "Latest",
    video_id: "latest",
    transcript_summary: "Summary",
    quantitative_alpha: {
      target_multiplier: 100,
      difficulty_epoch_progress: "50.00%",
      thermodynamic_signal: "elevated-target-distance",
    },
  },
];

test("resolves public pre-flight cost and MCP metadata", async () => {
  const urls: string[] = [];
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example/",
    wallet: { payInvoice: async () => preimage },
    fetch: async (input) => {
      urls.push(String(input));
      return Response.json(cost);
    },
  });

  assert.deepEqual(await client.getCost(), cost);
  assert.deepEqual(urls, ["https://node.example/api/v1/cost"]);
});

test("intercepts an L402 challenge, pays it, and retries automatically", async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  let paymentCalls = 0;
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example",
    wallet: {
      async payInvoice(invoice) {
        paymentCalls += 1;
        assert.equal(invoice, "lnbc-subscription");
        return { preimage };
      },
    },
    fetch: async (input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      requests.push({
        url: String(input),
        ...(authorization ? { authorization } : {}),
      });
      if (String(input).endsWith("/cost")) return Response.json(cost);
      if (!authorization) return Response.json(challenge, { status: 402 });
      return Response.json(records);
    },
  });

  assert.deepEqual(await client.getLatest(), records);
  assert.equal(paymentCalls, 1);
  assert.equal(requests.length, 3);
  assert.equal(
    requests[2].authorization,
    `L402 cached-macaroon:${preimage}`,
  );
});

test("reuses cached macaroons without paying another invoice", async () => {
  let paymentCalls = 0;
  let challengeCalls = 0;
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example",
    wallet: {
      async payInvoice() {
        paymentCalls += 1;
        return preimage;
      },
    },
    fetch: async (input, init) => {
      if (String(input).endsWith("/cost")) return Response.json(cost);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (!authorization) {
        challengeCalls += 1;
        return Response.json(challenge, { status: 402 });
      }
      return Response.json(records);
    },
  });

  await client.getLatest();
  await client.getLatest();
  assert.equal(paymentCalls, 1);
  assert.equal(challengeCalls, 1);
});

test("reconnects a closed SSE stream and continues telemetry delivery", async () => {
  const store = new MemoryCredentialStore();
  store.set("https://node.example:1-day", {
    macaroon: "cached-macaroon",
    preimage,
    validUntil: 2_000_000_000,
    tier: "1-day",
  });
  const telemetry: StratigraphyTelemetry = {
    observed_at: "2026-09-16T12:00:00.000Z",
    block: { height: 920_000 },
    difficulty: {
      epoch_progress_percent: 50,
      estimated_adjustment_percent: 1,
    },
    market: { usd_per_btc: 100_000, sats_per_usd: 1_000 },
    thermodynamic: {
      signal: "elevated-target-distance",
      target_multiplier: 100,
    },
  };
  let streamCalls = 0;
  const reconnectDelays: number[] = [];
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example",
    wallet: { payInvoice: async () => preimage },
    credentialStore: store,
    fetch: async () => {
      streamCalls += 1;
      return new Response(
        `event: telemetry\ndata: ${JSON.stringify(telemetry)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    sleep: async (delay) => {
      reconnectDelays.push(delay);
    },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
  });

  const received: StratigraphyTelemetry[] = [];
  let subscription!: ReturnType<typeof client.subscribeStream>;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for SSE reconnect")),
      1_000,
    );
    subscription = client.subscribeStream(
      (value) => {
        received.push(value);
        if (received.length === 2) {
          subscription.close();
          clearTimeout(timeout);
          resolve();
        }
      },
      () => undefined,
    );
  });

  assert.equal(streamCalls, 2);
  assert.deepEqual(received, [telemetry, telemetry]);
  assert.deepEqual(reconnectDelays, [5]);
  assert.equal(subscription.closed, true);
});

test("rejects a wallet preimage that does not match the challenged payment", async () => {
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example",
    wallet: { payInvoice: async () => "cd".repeat(32) },
    fetch: async (input) =>
      String(input).endsWith("/cost")
        ? Response.json(cost)
        : Response.json(challenge, { status: 402 }),
  });

  await assert.rejects(
    client.getLatest(),
    /preimage does not match the L402 payment hash/,
  );
});

test("parses SSE frames when CRLF separators span transport chunks", async () => {
  const store = new MemoryCredentialStore();
  store.set("https://node.example:1-day", {
    macaroon: "cached-macaroon",
    preimage,
    validUntil: 2_000_000_000,
    tier: "1-day",
  });
  const telemetry: StratigraphyTelemetry = {
    observed_at: "2026-09-16T12:00:00.000Z",
    block: { height: 920_000 },
    difficulty: {
      epoch_progress_percent: 50,
      estimated_adjustment_percent: 1,
    },
    market: { usd_per_btc: 100_000, sats_per_usd: 1_000 },
    thermodynamic: {
      signal: "elevated-target-distance",
      target_multiplier: 100,
    },
  };
  const encoder = new TextEncoder();
  const payload = `event: telemetry\r\ndata: ${JSON.stringify(telemetry)}\r\n\r\n`;
  const split = payload.lastIndexOf("\n");
  const chunks = [payload.slice(0, split - 1), payload.slice(split - 1)];
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example",
    wallet: { payInvoice: async () => preimage },
    credentialStore: store,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
      ),
    sleep: async (_delay, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  let subscription!: ReturnType<typeof client.subscribeStream>;
  const received = await new Promise<StratigraphyTelemetry>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("No telemetry")), 1_000);
    subscription = client.subscribeStream((value) => {
      clearTimeout(timeout);
      subscription.close();
      resolve(value);
    }, reject);
  });
  assert.deepEqual(received, telemetry);
});

test("reuses a concurrently refreshed credential instead of paying twice", async () => {
  let unauthenticatedRequests = 0;
  let paymentCalls = 0;
  let releaseDelayedChallenge!: () => void;
  const delayedChallenge = new Promise<void>((resolve) => {
    releaseDelayedChallenge = resolve;
  });
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example",
    wallet: {
      async payInvoice() {
        paymentCalls += 1;
        releaseDelayedChallenge();
        return preimage;
      },
    },
    fetch: async (input, init) => {
      if (String(input).endsWith("/cost")) return Response.json(cost);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization) return Response.json(records);
      unauthenticatedRequests += 1;
      if (unauthenticatedRequests === 2) await delayedChallenge;
      return Response.json(challenge, { status: 402 });
    },
  });

  const [first, second] = await Promise.all([
    client.getLatest(),
    client.getLatest(),
  ]);
  assert.deepEqual(first, records);
  assert.deepEqual(second, records);
  assert.equal(paymentCalls, 1);
});

test("dispatches a lone-CR-terminated SSE frame at EOF", async () => {
  const store = new MemoryCredentialStore();
  store.set("https://node.example:1-day", {
    macaroon: "cached-macaroon",
    preimage,
    validUntil: 2_000_000_000,
    tier: "1-day",
  });
  const telemetry = {
    observed_at: "2026-09-16T12:00:00.000Z",
    block: { height: 920_000 },
    difficulty: {
      epoch_progress_percent: 50,
      estimated_adjustment_percent: 1,
    },
    market: { usd_per_btc: 100_000, sats_per_usd: 1_000 },
    thermodynamic: {
      signal: "elevated-target-distance",
      target_multiplier: 100,
    },
  };
  const client = new BitcoinStratigraphyClient({
    baseUrl: "https://node.example",
    wallet: { payInvoice: async () => preimage },
    credentialStore: store,
    fetch: async () =>
      new Response(
        `event: telemetry\rdata: ${JSON.stringify(telemetry)}\r\r`,
      ),
    sleep: async (_delay, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  let subscription!: ReturnType<typeof client.subscribeStream>;
  const received = await new Promise<StratigraphyTelemetry>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("No telemetry")), 1_000);
    subscription = client.subscribeStream((value) => {
      clearTimeout(timeout);
      subscription.close();
      resolve(value);
    }, reject);
  });
  assert.deepEqual(received, telemetry);
});