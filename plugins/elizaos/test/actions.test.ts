import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import {
  bitcoinStratigraphyPlugin,
  broadcastMeshAction,
  bitcoinStratigraphyProvider,
  fetchBitcoinStratigraphyAction,
  getTelemetryAction,
  verifyProofAction,
} from "../src/index.js";
import { rememberTelemetry } from "../src/provider.js";

const preimage = "11".repeat(32);
const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const invoice = "lnbc123test";
const macaroon = "one-shot";
const challenge = new Response(JSON.stringify({
  invoice, macaroon, payment_hash: hash, amount_sats: 250,
}), {
  status: 402,
  headers: { "WWW-Authenticate": `L402 macaroon="${macaroon}", invoice="${invoice}"` },
});

function runtime(payInvoice?: (invoice: string) => Promise<string>): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "test-agent",
    getSetting: (key: string) => key === "NWC_PAIRING_SECRET"
      ? "nostr+walletconnect://test" : "https://example.test/mcp",
    getService: () => payInvoice ? { payInvoice } : null,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => { cache.set(key, value); return true; },
  } as unknown as IAgentRuntime;
}

function message(text: string, input?: Record<string, unknown>): Memory {
  return { content: { text, ...(input ? { input } : {}) } } as Memory;
}

function rpc(result: unknown) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id: 1, result: { structuredContent: result },
  }), { status: 200 });
}

test("exports three standard ElizaOS actions and fails closed without a wallet", async () => {
  assert.equal(bitcoinStratigraphyPlugin.actions?.length, 3);
  assert.equal(bitcoinStratigraphyPlugin.name, "bitcoin-stratigraphy");
  assert.ok(bitcoinStratigraphyPlugin.description);
  assert.deepEqual(bitcoinStratigraphyPlugin.services, []);
  assert.deepEqual(bitcoinStratigraphyPlugin.providers, [bitcoinStratigraphyProvider]);
  assert.equal(fetchBitcoinStratigraphyAction.name, "FETCH_BITCOIN_STRATIGRAPHY");
  assert.equal(getTelemetryAction, fetchBitcoinStratigraphyAction);
  for (const action of bitcoinStratigraphyPlugin.actions ?? []) {
    assert.ok(action.name && action.description && action.examples?.length);
    assert.ok(action.similes?.length);
    assert.equal(await action.validate(runtime(), message("test")), false);
  }
  const failure = await getTelemetryAction.handler(runtime(), message("last 7 days"));
  assert.equal(failure?.success, false);
  assert.match(failure?.text ?? "", /wallet service/);
});

test("paid actions require both a configured NWC pairing and a wallet service", async () => {
  let payments = 0;
  const agent = {
    ...runtime(async () => { payments++; return preimage; }),
    getSetting: (key: string) => key === "NWC_PAIRING_SECRET"
      ? undefined : "https://example.test/mcp",
  } as IAgentRuntime;
  assert.equal(await fetchBitcoinStratigraphyAction.validate(agent, message("today")), false);
  const result = await fetchBitcoinStratigraphyAction.handler(agent, message("today"));
  assert.equal(result?.success, false);
  assert.match(result?.text ?? "", /NWC_PAIRING_SECRET/);
  assert.equal(payments, 0);
});

test("provider reuses cached block and telemetry state without network or wallet calls", async () => {
  const agent = runtime();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Provider must not fetch"); }) as typeof fetch;
  try {
    assert.equal(await rememberTelemetry(agent, { records: [{
      day: 422,
      quantitative_alpha: {
        target_multiplier: 125.83,
        difficulty_epoch_progress: "42%",
        thermodynamic_signal: "strong",
      },
    }] }, 920_000), true);
    for (let i = 0; i < 2; i++) {
      const state = await bitcoinStratigraphyProvider.get(agent, message("current state"), {} as never);
      assert.match(state.text ?? "", /queried block height 920000/);
      assert.match(state.text ?? "", /"difficulty_epoch_progress":"42%"/);
      assert.equal(state.values?.bitcoinStratigraphyBlockHeight, 920_000);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telemetry pays through the runtime wallet and returns an ElizaOS action result", async () => {
  const originalFetch = globalThis.fetch;
  let payments = 0;
  const sent: Array<{ body: string; authorization?: string }> = [];
  const responses: string[] = [];
  const callback: HandlerCallback = async (content) => {
    responses.push(content.text ?? "");
    return [];
  };
  globalThis.fetch = (async (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    sent.push({ body: String(init?.body), authorization: headers.Authorization });
    return sent.length === 1 ? challenge : rpc({ records: [{
      day: 422, title: "Day 422", video_id: "video",
      transcript_summary: "Summary", quantitative_alpha: { target_multiplier: 125.83 },
    }] });
  }) as typeof fetch;
  try {
    const agent = runtime(async (requestedInvoice) => {
      assert.equal(requestedInvoice, invoice);
      payments++;
      return preimage;
    });
    const before = await bitcoinStratigraphyProvider.get(agent, message("before"), {} as never);
    assert.match(before.text ?? "", /No Bitcoin Stratigraphy telemetry/);
    const result = await getTelemetryAction.handler(
      agent,
      message("Give me the Bitcoin thermodynamic telemetry for 2026-09-09"),
      undefined, undefined, callback,
    );
    assert.equal(result?.success, true);
    assert.equal((result?.data?.records as unknown[]).length, 1);
    assert.match(responses[0] ?? "", /1 stratigraphy record/);
    assert.equal(payments, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.body, sent[1]?.body);
    assert.equal(sent[0]?.authorization, undefined);
    assert.equal(sent[1]?.authorization, `L402 ${macaroon}:${preimage}`);
    assert.deepEqual(JSON.parse(sent[0]!.body).params, {
      name: "stratigraphy.get", arguments: { date: "2026-09-09" },
    });
    const after = await bitcoinStratigraphyProvider.get(agent, message("after"), {} as never);
    assert.match(after.text ?? "", /day 422/);
    assert.match(after.text ?? "", /cached, not necessarily the current chain tip/);
    assert.equal(after.values?.bitcoinStratigraphyFetchedAt !== undefined, true);
    assert.equal(payments, 1);
    assert.equal(sent.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proof verification uses structured input and does not claim invalid proofs are valid", async () => {
  const originalFetch = globalThis.fetch;
  const sent: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return rpc({ valid: false, verifiedAt: "2026-09-24T00:00:00Z", computationTimeMs: 2 });
  }) as typeof fetch;
  try {
    const input = {
      proof: "encoded",
      publicInputs: {
        blockHeight: 920000, snapshotDigest: "123", thermodynamicHash: "456",
        timestamp: 1789776000000, valuationSat: 12583,
      },
      verificationKeyId: "sha256:abc",
      data: { block: { height: 920000 } },
    };
    const result = await verifyProofAction.handler(
      runtime(async () => preimage),
      message("Verify this proof", input),
    );
    assert.equal(result?.success, true);
    assert.match(result?.text ?? "", /invalid/);
    assert.deepEqual((sent[0] as { params: { arguments: unknown } }).params.arguments, input);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed proof and undated mesh requests fail before paying", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Should not call server"); }) as typeof fetch;
  let paid = 0;
  const agent = runtime(async () => { paid++; return preimage; });
  try {
    const invalidProof = await verifyProofAction.handler(agent, message("Verify my proof"));
    const invalidBroadcast = await broadcastMeshAction.handler(agent, message("Broadcast something"));
    const invalidTelemetry = await getTelemetryAction.handler(
      agent, message("last 7 days", { days: "not a number" }),
    );
    assert.equal(invalidProof?.success, false);
    assert.equal(invalidBroadcast?.success, false);
    assert.equal(invalidTelemetry?.success, false);
    assert.equal(paid, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mesh action sends only the canonical date selector", async () => {
  const originalFetch = globalThis.fetch;
  let params: unknown;
  globalThis.fetch = (async (_url, init) => {
    params = JSON.parse(String(init?.body)).params;
    return rpc({ signalType: "telemetry_snapshot", date: "2026-09-09",
      snapshotDigest: "ab".repeat(32), peerAttestations: 1,
      quorumThreshold: 2, merkleRoot: "cd".repeat(32), networkId: "mainnet" });
  }) as typeof fetch;
  try {
    const result = await broadcastMeshAction.handler(
      runtime(async () => preimage), message("Broadcast the signal for 2026-09-09"),
    );
    assert.equal(result?.success, true);
    assert.deepEqual(params, {
      name: "mesh.broadcast",
      arguments: { signalType: "telemetry_snapshot", payload: { date: "2026-09-09" } },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});