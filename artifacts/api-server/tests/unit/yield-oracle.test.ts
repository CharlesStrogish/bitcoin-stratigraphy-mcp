import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { generateSecretKey, getPublicKey, nip19, verifyEvent, type Event, type SimplePool } from "nostr-tools";
import { createYieldOracle, YIELD_ORACLE_RELAYS } from "../../src/services/yieldOracle";
import { registerClaimYieldRoute } from "../../src/routes/claim-yield";
import { YieldClaimError, type YieldClaim } from "../../src/lib/private-yield-earnings";
import { bech32 } from "@scure/base";
import { mockPayoutHash } from "../helpers/nwc-payout";
import { createSubscriptionMacaroon, attenuateSubscriptionMacaroon } from "../../src/lib/subscription-pass";

const secret = generateSecretKey();
const hex = Buffer.from(secret).toString("hex");

test("yield oracle signs exact Kind 1 notes with hex or nsec and publishes only allowlisted public data", async () => {
  const events: Event[] = [];
  let closed = 0;
  const poolFactory = () => ({
    publish(relays: string[], event: Event, options?: { maxWait?: number }) {
      assert.deepEqual(relays, [...YIELD_ORACLE_RELAYS]);
      assert.equal(options?.maxWait, 5000);
      events.push(event);
      return relays.map(() => Promise.resolve("accepted"));
    },
    destroy() { closed++; },
  });
  for (const key of [hex, nip19.nsecEncode(secret)]) {
    const broadcast = createYieldOracle({ privateKey: () => key, poolFactory, now: () => 1_800_000_000_000 });
    await broadcast(21000n);
    await broadcast(1234n);
    await broadcast(21000n);
  }
  assert.equal(closed, 6);
  assert.equal(new Set(events.map(event => event.id)).size, 6, "Equal amounts in one second remain distinct events");
  for (const [i, event] of events.entries()) {
    assert.equal(event.kind, 1);
    assert.equal(event.created_at, 1800000000);
    assert.equal(event.pubkey, getPublicKey(secret));
    assert.ok(verifyEvent(event));
    const amount = i % 3 === 1 ? "1.234" : "21";
    assert.equal(event.content, `An autonomous agent just settled a ${amount} satoshi yield withdrawal from the BitcoinStratigraphy.com L402 Data Engine. 100% Mainnet execution.`);
    assert.deepEqual(event.tags.map(tag => tag[0]), ["t", "event"]);
    assert.deepEqual(Object.keys(event).sort(), ["content", "created_at", "id", "kind", "pubkey", "sig", "tags"]);
    assert.ok(!JSON.stringify(event).includes(hex));
  }
});

test("missing or invalid oracle keys, relay rejection, timeout, cleanup and signing errors are caught", async () => {
  const warnings: string[] = [];
  let constructed = 0, destroyed = 0;
  let mode: "reject" | "hang" | "throw" | "cleanup" = "reject";
  const poolFactory = (): Pick<SimplePool, "publish" | "destroy"> => {
    constructed++;
    return {
      publish() {
        if (mode === "throw") throw new Error("sensitive provider detail");
        if (mode === "hang") return [new Promise(() => {})];
        return [Promise.reject(new Error("sensitive provider detail"))];
      },
      destroy() {
        destroyed++;
        if (mode === "cleanup") throw new Error("cleanup error");
      },
    };
  };
  for (const value of [undefined, "not-a-private-key", "00".repeat(32)]) {
    await createYieldOracle({ privateKey: () => value, poolFactory, warn: event => warnings.push(event) })(21000n);
  }
  assert.equal(constructed, 0);
  const broadcast = createYieldOracle({
    privateKey: () => hex, poolFactory, timeoutMs: 5, warn: event => warnings.push(event),
  });
  await broadcast(21000n);
  mode = "hang"; await broadcast(21000n);
  mode = "throw"; await broadcast(21000n);
  mode = "cleanup"; await broadcast(21000n);
  assert.equal(destroyed, 4);
  assert.ok(warnings.includes("yield_oracle_key_missing"));
  assert.ok(warnings.includes("yield_oracle_relay_timeout"));
  assert.ok(warnings.includes("yield_oracle_relays_rejected"));
  assert.ok(!warnings.join(" ").includes("sensitive"));
  await createYieldOracle({ privateKey: () => hex, poolFactory, warn: () => { throw new Error("logger down"); } })(1n);
  await createYieldOracle({ privateKey: () => hex })(21000n); // CI cannot open a real relay.
});

test("claim-yield broadcasts strictly after settlement without awaiting hung relays or surfacing callback errors", async () => {
  const app = express();
  app.use(express.json());
  let status: "settled" | "pending" | "failed" | "replay" = "settled";
  let calls = 0, completed = 0;
  const claimId = randomUUID();
  registerClaimYieldRoute(app, {
    async claim(): Promise<YieldClaim> {
      if (status === "failed") throw new YieldClaimError(502, "NWC_PAYMENT_FAILED_BALANCES_RELEASED");
      if (status === "replay") throw new YieldClaimError(409, "WITHDRAWAL_INVOICE_ALREADY_USED");
      completed++;
      return { claimId, totalMsats: 21000n, receiptCount: 1, paymentStatus: status };
    },
  }, {
    secret: "test-only", logSettlement() {},
    broadcastYield(amount) {
      assert.ok(completed > 0, "Ledger settlement must finish before broadcast");
      assert.equal(amount, 21000n);
      calls++;
      if (calls === 1) return new Promise(() => {}); // A relay that never finishes.
      if (calls === 2) throw new Error("synchronous signing failure");
      return Promise.reject(new Error("asynchronous relay failure"));
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let timestamp = Math.floor(Date.now() / 1000);
  const words = Array(7).fill(0);
  for (let i = 6; i >= 0; i--) { words[i] = timestamp % 32; timestamp = Math.floor(timestamp / 32); }
  words.push(1, 1, 20, ...bech32.toWords(Buffer.from(mockPayoutHash(), "hex")));
  const description = bech32.toWords(Buffer.from("oracle test"));
  words.push(13, 0, description.length, ...description, ...Array(104).fill(0));
  const invoice = bech32.encode("lnbc210000p", words, 4096);
  const send = () => fetch(`http://127.0.0.1:${address.port}/api/claim-yield`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ macaroons: ["test-receipt"], bolt11_invoice: invoice }),
    signal: AbortSignal.timeout(1000),
  });
  // Use an actual authenticated bearer receipt; only the payout ledger is stubbed.
  const root = createSubscriptionMacaroon({
    secret: "test-only", paymentHash: mockPayoutHash(), tier: "1-day", validUntil: 1,
    amountMsats: 100000, paymentAsset: "btc-lightning", paymentProvider: "mock",
  });
  const macaroon = attenuateSubscriptionMacaroon(root, ["allowed_path=/paid", "max_requests=1"])!;
  const sendClaim = () => fetch(`http://127.0.0.1:${address.port}/api/claim-yield`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ macaroons: [macaroon], bolt11_invoice: invoice }),
    signal: AbortSignal.timeout(1000),
  });
  try {
    assert.equal((await send()).status, 403);
    for (let i = 0; i < 3; i++) {
      const response = await sendClaim();
      assert.equal(response.status, 200);
      assert.equal((await response.json()).payment_sent, true);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(calls, 3);
    status = "pending"; assert.equal((await sendClaim()).status, 202);
    status = "failed"; assert.equal((await sendClaim()).status, 502);
    status = "replay"; assert.equal((await sendClaim()).status, 409);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 3, "Pending, failed and replayed claims never broadcast");
  } finally {
    server.close();
    await once(server, "close");
  }
});
