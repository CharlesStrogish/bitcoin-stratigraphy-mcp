import assert from "node:assert/strict";
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

function request(
  kind: number,
  payload: unknown,
  tags: string[][] = [],
): Event {
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

test("loads DVM configuration with validated key and fallback relays", () => {
  const privateKey = generateSecretKey();
  const loaded = loadDvmConfig({
    NOSTR_PRIVATE_KEY: Buffer.from(privateKey).toString("hex"),
  });
  assert.equal(loaded.publicKey, getPublicKey(privateKey));
  assert.deepEqual(loaded.relays, [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
  ]);
  assert.equal(loaded.stratigraphyFeeSats, 5);
  assert.throws(
    () => loadDvmConfig({}),
    /NOSTR_PRIVATE_KEY is required/,
  );
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
  const textAndParams = request(
    5_000,
    "Fetch latest stratigraphy telemetry",
    [
      ["i", "latest", "text"],
      ["param", "recentDays", "1"],
    ],
  );
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

  const paramsOnly = request(5_000, "", [
    ["param", "recentDays", "1"],
  ]);
  assert.deepEqual(parseDvmRequest(paramsOnly), { recentDays: 1 });
});

test("requires settlement before publishing a signed NIP-90 result", async () => {
  const published: Event[] = [];
  const dvm = createNip90Dvm(config(), {
    transport: fakeTransport(published),
    createInvoice: async () => ({
      invoice: "lnbc5n1test",
      paymentHash: "ab".repeat(32),
      provider: "coinos",
    }),
    waitForSettlement: async () => true,
    queryStratigraphy: async (input) => ({
      records: [{ day: input.days }],
    }),
    now: () => 1_789_963_200_000,
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
      .map((candidate) =>
        candidate.tags.find((tag) => tag[0] === "status")?.[1]
      ),
    ["payment-required", "processing", "success"],
  );
  const payment = published[0]!.tags.find((tag) => tag[0] === "amount");
  assert.deepEqual(payment, ["amount", "5000", "lnbc5n1test"]);
  const result = published[2]!;
  assert.equal(verifyEvent(result), true);
  assert.equal(
    result.tags.find((tag) => tag[0] === "e")?.[1],
    event.id,
  );
  assert.equal(
    result.tags.find((tag) => tag[0] === "p")?.[1],
    event.pubkey,
  );
  assert.deepEqual(JSON.parse(result.content), {
    records: [{ day: 7 }],
  });

  await dvm.handleEvent(event);
  assert.equal(published.length, 4, "duplicate requests must be ignored");
  await dvm.stop();
});

test("does not execute unpaid, unsupported, or differently targeted jobs", async () => {
  const published: Event[] = [];
  let executions = 0;
  const dvmConfig = config();
  const dvm = createNip90Dvm(dvmConfig, {
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
    published.map((candidate) =>
      candidate.tags.find((tag) => tag[0] === "status")?.[1]
    ),
    ["payment-required", "error"],
  );
  assert.deepEqual(
    published[1]!.tags.find((tag) => tag[0] === "status"),
    [
      "status",
      "error",
      "Lightning invoice expired or was not settled",
    ],
  );

  await dvm.handleEvent(request(5_500, {}));
  await dvm.handleEvent(request(5_991, {}, [["t", "stratigraphy"]]));
  await dvm.handleEvent(
    request(5_002, {}, [["p", "ff".repeat(32)]]),
  );
  assert.equal(published.length, 2);
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
          payment_hash: "ef".repeat(32),
          invoice: "lnbc5n1test",
          created_at: 1,
          expires_at: 2,
          settled_at: 3,
          preimage: "01".repeat(32),
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
        paymentHash: "ef".repeat(32),
        provider: "coinos",
        amountMsats: 5_000,
        description: "DVM job",
      },
      { signal: new AbortController().signal, timeoutMs: 100 },
    );
    assert.equal(settled, true);
    assert.equal(lookups, 2);
    assert.equal(closes, 2);
  } finally {
    if (previous === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = previous;
  }
});