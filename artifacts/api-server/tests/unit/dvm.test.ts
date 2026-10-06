import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";
import {
  createNip90Dvm,
  createNwcSettlementWaiter,
  loadDvmConfig,
  parseDvmRequest,
  type DvmConfig,
  type DvmTransport,
} from "../../src/services/dvm";
import { createMemoryRevenueLedger } from "../../src/services/ledger";
import { createPricingEngine } from "../../src/services/pricing";

function config(privateKey = generateSecretKey()): DvmConfig {
  return {
    privateKey,
    publicKey: getPublicKey(privateKey),
    relays: ["wss://relay.example"],
    stratigraphyFeeSats: 5,
    proofFeeSats: 21,
    invoiceExpirySeconds: 60,
    settlementPollMs: 1,
    maxConcurrentJobs: 2,
    maxPendingPayments: 4,
  };
}

function request(kind: number, payload: unknown, tags: string[][] = []): Event {
  return finalizeEvent(
    {
      kind,
      content: JSON.stringify(payload),
      tags,
      created_at: 1_789_963_200,
    },
    generateSecretKey(),
  );
}

function fakeTransport(published: Event[]): DvmTransport {
  return {
    subscribe(_filter: Filter, _onEvent: (event: Event) => void) {
      return () => {};
    },
    async publish(event) {
      published.push(event);
    },
    close() {},
  };
}

const SETTLED_PREIMAGE = "01".repeat(32);
const SETTLED_PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(SETTLED_PREIMAGE, "hex"))
  .digest("hex");

test("loads DVM configuration with validated key and fallback relays", () => {
  const privateKey = generateSecretKey();
  const loaded = loadDvmConfig({
    NOSTR_PRIVATE_KEY: Buffer.from(privateKey).toString("hex"),
  });
  assert.equal(loaded.publicKey, getPublicKey(privateKey));
  assert.deepEqual(loaded.relays, [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.nostr.band",
  ]);
  assert.equal(loaded.stratigraphyFeeSats, 5);
  assert.throws(
    () => loadDvmConfig({}),
    /NOSTR_PRIVATE_KEY or SESSION_SECRET is required/,
  );
  const fallback = loadDvmConfig({ SESSION_SECRET: "test-only-private-seed" });
  assert.equal(
    fallback.publicKey,
    loadDvmConfig({ SESSION_SECRET: "test-only-private-seed" }).publicKey,
  );
  assert.notEqual(fallback.publicKey, loaded.publicKey);
  assert.throws(
    () =>
      loadDvmConfig({
        NOSTR_PRIVATE_KEY: Buffer.from(privateKey).toString("hex"),
        NOSTR_RELAYS: "https://not-a-websocket.example",
      }),
    /non-WebSocket URL/,
  );
});

test("accepts standard NIP-90 text, URL, and parameter inputs", () => {
  const textAndParams = request(5_000, "Fetch latest stratigraphy telemetry", [
    ["i", "latest", "text"],
    ["param", "recentDays", "1"],
  ]);
  assert.deepEqual(parseDvmRequest(textAndParams), {
    recentDays: 1,
    input: "latest",
  });

  const urlAndParams = request(5_002, "", [
    ["i", "https://example.com/proof.json", "url"],
    ["param", "verificationKeyId", "zk-telemetry-v1"],
  ]);
  assert.deepEqual(parseDvmRequest(urlAndParams), {
    verificationKeyId: "zk-telemetry-v1",
    url: "https://example.com/proof.json",
  });

  const paramsOnly = request(5_000, "", [["param", "recentDays", "1"]]);
  assert.deepEqual(parseDvmRequest(paramsOnly), { recentDays: 1 });
});

test("requires settlement before publishing a signed NIP-90 result", async () => {
  const published: Event[] = [];
  const ledger = createMemoryRevenueLedger();
  const dvm = createNip90Dvm(config(), {
    pricingEngine: createPricingEngine({ maxLoadMultiplier: 1 }),
    transport: fakeTransport(published),
    createInvoice: async () => ({
      invoice: "lnbc5n1test",
      paymentHash: SETTLED_PAYMENT_HASH,
      provider: "coinos",
    }),
    waitForSettlement: async () => ({
      settledAt: 1_789_963_200,
      preimage: SETTLED_PREIMAGE,
    }),
    queryStratigraphy: async (input) => ({
      records: [{ day: input.days }],
    }),
    now: () => 1_789_963_200_000,
    ledger,
  });
  dvm.start();
  const event = request(5_000, { days: 7 }, [["t", "stratigraphy"]]);
  await dvm.handleEvent(event);

  assert.deepEqual(
    published.map((candidate) => candidate.kind),
    [7_000, 7_000, 6_000, 7_000],
  );
  assert.deepEqual(
    published
      .filter((candidate) => candidate.kind === 7_000)
      .map(
        (candidate) => candidate.tags.find((tag) => tag[0] === "status")?.[1],
      ),
    ["payment-required", "processing", "success"],
  );
  const payment = published[0]!.tags.find((tag) => tag[0] === "amount");
  assert.deepEqual(payment, ["amount", "5000", "lnbc5n1test"]);
  const result = published[2]!;
  assert.equal(verifyEvent(result), true);
  assert.equal(result.tags.find((tag) => tag[0] === "e")?.[1], event.id);
  assert.equal(result.tags.find((tag) => tag[0] === "p")?.[1], event.pubkey);
  assert.deepEqual(JSON.parse(result.content), {
    records: [{ day: 7 }],
  });
  assert.equal(await ledger.getTotalVolume(), 5);
  assert.equal((await ledger.getRecent())[0]?.channel, "NIP-90");

  await dvm.handleEvent(event);
  assert.equal(published.length, 4, "duplicate requests must be ignored");
  await dvm.stop();
});

test("does not execute unpaid, unsupported, or differently targeted jobs", async () => {
  const published: Event[] = [];
  let executions = 0;
  const dvmConfig = config();
  const dvm = createNip90Dvm(dvmConfig, {
    pricingEngine: createPricingEngine({ maxLoadMultiplier: 1 }),
    transport: fakeTransport(published),
    createInvoice: async () => ({
      invoice: "lnbc21n1test",
      paymentHash: "cd".repeat(32),
      provider: "coinos",
    }),
    waitForSettlement: async () => false,
    verifyProof: async () => {
      executions += 1;
      return { valid: true };
    },
  });
  dvm.start();
  await dvm.handleEvent(request(5_002, { proof: "encoded" }));
  assert.equal(executions, 0);
  assert.deepEqual(
    published.map(
      (candidate) => candidate.tags.find((tag) => tag[0] === "status")?.[1],
    ),
    ["payment-required", "error"],
  );
  assert.deepEqual(
    published[1]!.tags.find((tag) => tag[0] === "status"),
    ["status", "error", "Lightning invoice expired or was not settled"],
  );

  await dvm.handleEvent(request(5_500, {}));
  await dvm.handleEvent(request(5_991, {}, [["t", "stratigraphy"]]));
  await dvm.handleEvent(request(5_002, {}, [["p", "ff".repeat(32)]]));
  assert.equal(published.length, 2);
  await dvm.stop();
});

test("kind 5050 serves tagged bitcoin, stratigraphy, and zk jobs after 250-sat settlement", async () => {
  const published: Event[] = [];
  const operations: string[] = [];
  const dvm = createNip90Dvm(config(), {
    transport: fakeTransport(published),
    createInvoice: async ({ amountMsats }) => {
      assert.equal(amountMsats, 250_000);
      return {
        invoice: "lnbc2500n1test",
        paymentHash: SETTLED_PAYMENT_HASH,
        provider: "coinos",
      };
    },
    waitForSettlement: async () => ({
      settledAt: 1_789_963_200,
      preimage: SETTLED_PREIMAGE,
    }),
    queryStratigraphy: async () => {
      operations.push("stratigraphy");
      return { records: [] };
    },
    verifyProof: async () => {
      operations.push("zk");
      return { valid: true };
    },
    now: () => 1_789_963_200_000,
  });
  dvm.start();
  for (const [topic, expected] of [
    ["bitcoin", "stratigraphy"],
    ["#stratigraphy", "stratigraphy"],
    ["zk", "zk"],
  ]) {
    const job = request(5_050, { days: 1 }, [["t", topic]]);
    await dvm.handleEvent(job);
    const events = published.splice(0);
    assert.deepEqual(
      events.map((event) => event.kind),
      [7_000, 7_000, 6_050, 7_000],
    );
    for (const feedback of events.filter((event) => event.kind === 7_000)) {
      assert.equal(verifyEvent(feedback), true);
      assert.deepEqual(
        feedback.tags.find((tag) => tag[0] === "e"),
        ["e", job.id],
      );
      assert.deepEqual(
        feedback.tags.find((tag) => tag[0] === "p"),
        ["p", job.pubkey],
      );
    }
    assert.deepEqual(
      events
        .filter((event) => event.kind === 7_000)
        .map((event) => event.tags.find((tag) => tag[0] === "status")?.[1]),
      ["payment-required", "processing", "success"],
    );
    assert.deepEqual(
      events[0]!.tags.find((tag) => tag[0] === "amount"),
      ["amount", "250000", "lnbc2500n1test"],
    );
    assert.match(
      events[0]!.tags.find((tag) => tag[0] === "status")?.[2] ?? "",
      /invoice/,
    );
    assert.equal(operations.at(-1), expected);
  }
  await dvm.handleEvent(request(5_050, {}, [["t", "unrelated"]]));
  assert.equal(published.length, 0);
  await dvm.stop();
});

test("polls the issuing NWC wallet until the DVM invoice settles", async () => {
  let lookups = 0;
  let closes = 0;
  const waiter = createNwcSettlementWaiter(
    () => ({
      makeInvoice: async () => {
        throw new Error("not used");
      },
      lookupInvoice: async () => {
        lookups += 1;
        return {
          type: "incoming",
          state: lookups === 1 ? "pending" : "settled",
          amount: 5_000,
          description: "DVM job",
          payment_hash: SETTLED_PAYMENT_HASH,
          invoice: "lnbc5n1test",
          created_at: 1,
          expires_at: 2,
          settled_at: 3,
          preimage: SETTLED_PREIMAGE,
          fees_paid: 0,
        };
      },
      close() {
        closes += 1;
      },
    }),
    1,
  );
  const previous = process.env.NWC_URI;
  process.env.NWC_URI = "nostr+walletconnect://test";
  try {
    const settled = await waiter(
      {
        invoice: "lnbc5n1test",
        paymentHash: SETTLED_PAYMENT_HASH,
        provider: "coinos",
        amountMsats: 5_000,
        description: "DVM job",
      },
      { signal: new AbortController().signal, timeoutMs: 100 },
    );
    assert.deepEqual(settled, {
      settledAt: 3,
      preimage: SETTLED_PREIMAGE,
    });
    assert.equal(lookups, 2);
    assert.equal(closes, 2);
  } finally {
    if (previous === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = previous;
  }
});
