import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BitcoinStratigraphyClient as RestClient } from "@bitcoin-stratigraphy/sdk";
import type { BitcoinStratigraphyClient as McpClient } from "@bitcoin-stratigraphy/sdk/mcp";
import { runAgentLoop, runCycle, type AgentDependencies, type AgentEvent } from "../src/agentLoop.js";
import { redactDiagnostic, requireNwcPairingSecret } from "../src/runner.js";
import { createStateStore, type Checkpoint, type StateStore } from "../src/state.js";
import { createLnurlCapableWallet, createNwcWallet } from "../src/wallet.js";

function fixture(peerCount = 0, valid = true) {
  let checkpoint: Checkpoint | null = null;
  const events: AgentEvent[] = [];
  const calls = { paidDataset: 0, verified: 0, catalog: 0, broadcast: 0 };
  const data = [{
    day: 422, title: "Day 422", video_id: "source",
    transcript_summary: "Thermodynamic support",
    quantitative_alpha: {
      target_multiplier: 125.83,
      difficulty_epoch_progress: "73.42%",
      thermodynamic_signal: "accumulation",
    },
  }];
  const store: StateStore = {
    load: async () => checkpoint,
    save: async (value) => { checkpoint = value; },
    close: async () => {},
  };
  const dependencies: AgentDependencies = {
    rest: {
      getLatest: async () => {
        calls.paidDataset++;
        return {
          data,
          zkProof: {
            proof: "encoded-proof",
            publicInputs: {
              blockHeight: 920000, snapshotDigest: "123", thermodynamicHash: "456",
              timestamp: 1789776000000, valuationSat: 12583,
            },
            verificationKeyId: "sha256:abc",
          },
          meshConsensus: {} as never,
        };
      },
    } satisfies Pick<RestClient, "getLatest">,
    mcp: {
      verifyProof: async (args) => {
        assert.equal(args.proof, "encoded-proof");
        assert.deepEqual(args.data, data);
        calls.verified++;
        return { valid, verifiedAt: "2026-09-24T00:00:00Z", computationTimeMs: 2 };
      },
      getMeshStatus: async () => ({
        nodePubkey: "a".repeat(64), configuredPeerCount: peerCount,
        topologyHealth: peerCount ? "healthy" as const : "isolated" as const,
        activePeerCount: peerCount + 1, crossValidationSuccessRate: 1,
        averagePropagationLatencyMs: 1, quorumThreshold: 2,
      }),
      listStratigraphy: async () => {
        calls.catalog++;
        return {
          totalSnapshots: 422, oldestBlock: 859376, newestBlock: 920000,
          availableMetrics: [], dateBounds: { startDate: "2025-07-15", endDate: "2026-09-09" },
        };
      },
      broadcastMeshSignal: async (date) => {
        calls.broadcast++;
        assert.equal(date, "2026-09-09");
        return {
          signalType: "telemetry_snapshot" as const, date,
          snapshotDigest: "ab".repeat(32), peerAttestations: 1,
          quorumThreshold: 2, merkleRoot: "cd".repeat(32), networkId: "mainnet",
        };
      },
    } satisfies AgentDependencies["mcp"],
    store,
    emit: (event) => events.push(event),
  };
  return { dependencies, events, calls, getCheckpoint: () => checkpoint };
}

test("verifies new dataset proof once; isolated mesh remains pending", async () => {
  const { dependencies, events, calls, getCheckpoint } = fixture();
  await runCycle(dependencies);
  await runCycle(dependencies);
  assert.equal(calls.paidDataset, 2);
  assert.equal(calls.verified, 1);
  assert.equal(calls.catalog, 0);
  assert.equal(calls.broadcast, 0);
  assert.equal(getCheckpoint()?.verified, true);
  assert.equal(events.filter((event) => event.type === "isolated").length, 2);
  const telemetry = events.find((event) => event.type === "telemetry");
  assert.ok(telemetry?.type === "telemetry");
  assert.match(telemetry.telemetryHash, /^[0-9a-f]{64}$/);
});

test("broadcasts only after verification and checkpoints the peer receipt", async () => {
  const { dependencies, calls, getCheckpoint, events } = fixture(2);
  await runCycle(dependencies);
  await runCycle(dependencies);
  assert.equal(calls.verified, 1);
  assert.equal(calls.broadcast, 1);
  assert.equal(getCheckpoint()?.broadcastDate, "2026-09-09");
  assert.deepEqual(events.filter((event) => event.type === "verified" || event.type === "broadcast")
    .map((event) => event.type), ["verified", "broadcast"]);
});

test("invalid proof stops before saving state or broadcasting", async () => {
  const { dependencies, calls, getCheckpoint } = fixture(2, false);
  await assert.rejects(runCycle(dependencies), /proof was invalid/);
  assert.equal(getCheckpoint(), null);
  assert.equal(calls.broadcast, 0);
});

test("wallet adapters refuse non-preimage payments", async () => {
  assert.throws(() => createNwcWallet("not-a-pairing-uri"), /pairing URI/);
  const wallet = createLnurlCapableWallet(async () => ({ payment_preimage: "uuid" }));
  await assert.rejects(wallet.payInvoice("lnbc1..."), /32-byte hex/);
});

test("CoinOS nested NWC preimage reaches the MCP wallet callback", async () => {
  const preimage = "a1".repeat(32);
  const invoices: string[] = [];
  const wallet = createNwcWallet(
    "nostr+walletconnect://test",
    (invoice) => invoices.push(invoice),
    {
      async payInvoice({ invoice }) {
        assert.equal(invoice, "lnbc-test");
        return { result: { preimage: Buffer.from(preimage, "hex").toString("base64") } };
      },
    },
  );
  assert.equal(await wallet.payMcpInvoice("lnbc-test"), preimage);
  assert.deepEqual(invoices, ["lnbc-test"]);
  wallet.close();
});

test("the seeder prioritizes NWC and fails closed on provider-ambiguous keys", () => {
  assert.equal(
    requireNwcPairingSecret({
      NWC_PAIRING_SECRET: "nostr+walletconnect://example",
      LNURL_PAYMENT_KEY: "not-a-wallet-protocol",
    }),
    "nostr+walletconnect://example",
  );
  assert.throws(
    () => requireNwcPairingSecret({ LNURL_PAYMENT_KEY: "lnbits-or-alby" }),
    /LNURL_PAYMENT_KEY alone cannot safely settle L402 invoices/,
  );
  assert.throws(() => requireNwcPairingSecret({}), /Set NWC_PAIRING_SECRET/);
});

test("cycle failures preserve their message and stack for redacted diagnostics", async () => {
  const { dependencies } = fixture();
  const failure = new Error("Payment settled but response.result.preimage was missing");
  dependencies.rest.getLatest = async () => { throw failure; };
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  dependencies.emit = (event) => { events.push(event); controller.abort(); };
  await runAgentLoop(dependencies, 900_000, controller.signal);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type !== "error") return;
  assert.equal(events[0].error, failure.message);
  assert.match(events[0].stack ?? "", /Payment settled/);
  const sanitized = redactDiagnostic(
    `Invoice lnbc123abc, L402 macaroon:${"11".repeat(32)}; ${failure.message}`,
  );
  assert.match(sanitized, /response\.result\.preimage was missing/);
  assert.doesNotMatch(sanitized, /lnbc123abc|macaroon:|1111111111/);
});

test("uninitialized PostgreSQL falls back to preflighted local state only in development", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stratigraphy-state-"));
  const localFile = join(dir, "checkpoint.json");
  const url = "postgresql://127.0.0.1:1/absent";
  try {
    const store = await createStateStore({ url, production: false, localFile });
    assert.equal(await store.load(), null);
    await store.save({ snapshotKey: "paid-snapshot", verified: true });
    assert.deepEqual(await store.load(), { snapshotKey: "paid-snapshot", verified: true });
    await store.close();
    await assert.rejects(createStateStore({ url, production: true, localFile }));
    await writeFile(localFile, "not-json");
    await assert.rejects(createStateStore({ url: null, production: false, localFile }), /JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});