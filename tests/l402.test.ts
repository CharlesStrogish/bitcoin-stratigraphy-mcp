import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { createL402Middleware } from "../artifacts/api-server/src/middleware/l402";
import {
  generateCryptographicAttestation,
  verifyCryptographicAttestation,
} from "../artifacts/api-server/src/services/attestation";
import {
  createSubscriptionMacaroon,
} from "../artifacts/api-server/src/lib/subscription-pass";
import type { SettlementRouter } from "../artifacts/api-server/src/services/settlement";
import { createMemoryRevenueLedger } from "../artifacts/api-server/src/services/ledger";
import {
  createNwcSettlementProvider,
} from "../artifacts/api-server/src/services/settlement/nwc-provider";

const PREIMAGE = "01".repeat(32);
const TEST_NOSTR_PRIVATE_KEY = "01".padStart(64, "0");
const TEST_NOSTR_PUBLIC_KEY = getPublicKey(
  Uint8Array.from(Buffer.from(TEST_NOSTR_PRIVATE_KEY, "hex")),
);
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex");

function fakeSettlementRouter(): SettlementRouter {
  let invoiceCount = 0;
  return {
    isConfigured: () => true,
    activeProvider: () => "test-wallet",
    circuitState: () => "closed",
    async createInvoice() {
      invoiceCount += 1;
      return {
        invoice: `lnbc5n1test${invoiceCount}`,
        paymentHash: PAYMENT_HASH,
        provider: "test-wallet",
      };
    },
    async verifyPayment(input) {
      return input.paymentHash === PAYMENT_HASH &&
          input.preimage === PREIMAGE &&
          input.expectedAmountMsats === 5_000 &&
          input.expectedDescription === "test paid route" &&
          input.expectedProvider === "test-wallet"
        ? { settledAt: 1_789_963_200, provider: "test-wallet" }
        : "invalid";
    },
  };
}

test("issues an L402 challenge and accepts a hash-bound settled preimage", async () => {
  const app = express();
  const ledger = createMemoryRevenueLedger();
  let dynamicAmountSats = 5;
  app.get(
    "/paid",
    createL402Middleware({
      amountSats: () => dynamicAmountSats,
      description: "test paid route",
      settlementRouter: fakeSettlementRouter(),
      sessionSecret: "test-session-secret",
      now: () => 1_789_963_200_000,
      ledger,
      requestKind: "stratigraphy",
    }),
    (_req, res) => res.status(200).json({ paid: true }),
  );
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const challenge = await fetch(`${baseUrl}/paid`);
    assert.equal(challenge.status, 402);
    const authenticate = challenge.headers.get("www-authenticate");
    assert.ok(authenticate);
    const match = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(
      authenticate,
    );
    assert.ok(match);
    assert.match(match[2]!, /^lnbc/);
    assert.equal((await challenge.json() as { amount_sats: number }).amount_sats, 5);

    dynamicAmountSats = 9;
    const paid = await fetch(`${baseUrl}/paid`, {
      headers: { Authorization: `L402 ${match[1]}:${PREIMAGE}` },
    });
    assert.equal(paid.status, 200);
    assert.deepEqual(await paid.json(), { paid: true });
    assert.equal(await ledger.getTotalVolume(), 5);

    const replay = await fetch(`${baseUrl}/paid`, {
      headers: { Authorization: `L402 ${match[1]}:${PREIMAGE}` },
    });
    assert.equal(replay.status, 429);
    assert.equal(await ledger.getTotalVolume(), 5);

    const wrongPreimage = await fetch(`${baseUrl}/paid`, {
      headers: { Authorization: `L402 ${match[1]}:${"02".repeat(32)}` },
    });
    assert.equal(wrongPreimage.status, 402);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("verifies signed cryptographic attestations and rejects tampering", () => {
  const attestation = generateCryptographicAttestation(
    { height: 900_000, telemetry: ["alpha", "beta"] },
    {
      privateKey: TEST_NOSTR_PRIVATE_KEY,
      timestamp: 1_789_963_200_000,
    },
  );
  assert.equal(
    verifyCryptographicAttestation(attestation, {
      issuerPublicKey: TEST_NOSTR_PUBLIC_KEY,
    }),
    true,
  );
  assert.equal(
    verifyCryptographicAttestation(
      {
        ...attestation,
        payload: { height: 900_001, telemetry: ["alpha", "beta"] },
      },
      { issuerPublicKey: TEST_NOSTR_PUBLIC_KEY },
    ),
    false,
  );
  const attackerAttestation = generateCryptographicAttestation(
    { height: 900_000 },
    {
      privateKey: "02".padStart(64, "0"),
      timestamp: 1_789_963_200_000,
    },
  );
  assert.equal(
    verifyCryptographicAttestation(attackerAttestation, {
      issuerPublicKey: TEST_NOSTR_PUBLIC_KEY,
    }),
    false,
  );
});

test("rejects a paid but path-unbound macaroon on a fixed-fee route", async () => {
  const app = express();
  const macaroon = createSubscriptionMacaroon({
    secret: "test-session-secret",
    paymentHash: PAYMENT_HASH,
    tier: "1-day",
    validUntil: 1_789_963_300,
    amountMsats: 5_000,
    paymentAsset: "btc-lightning",
    paymentProvider: "test-wallet",
  });
  app.get(
    "/paid",
    createL402Middleware({
      amountSats: 5,
      description: "test paid route",
      settlementRouter: fakeSettlementRouter(),
      sessionSecret: "test-session-secret",
      now: () => 1_789_963_200_000,
    }),
    (_req, res) => res.status(200).end(),
  );
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/paid`, {
      headers: { Authorization: `L402 ${macaroon}:${PREIMAGE}` },
    });
    assert.equal(response.status, 402);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("rejects malformed attestation events without throwing", () => {
  const attestation = generateCryptographicAttestation(
    { height: 900_000 },
    {
      privateKey: TEST_NOSTR_PRIVATE_KEY,
      timestamp: 1_789_963_200_000,
    },
  );
  assert.doesNotThrow(() => {
    assert.equal(
      verifyCryptographicAttestation(
        {
          ...attestation,
          signature: {
            ...attestation.signature,
            event: null,
          },
        },
        { issuerPublicKey: TEST_NOSTR_PUBLIC_KEY },
      ),
      false,
    );
  });
});

test("rejects a valid signature carrying ambiguous attestation tags", () => {
  const attestation = generateCryptographicAttestation(
    { height: 900_000 },
    {
      privateKey: TEST_NOSTR_PRIVATE_KEY,
      timestamp: 1_789_963_200_000,
    },
  );
  const event = finalizeEvent(
    {
      kind: attestation.signature.event.kind,
      created_at: attestation.signature.event.created_at,
      content: attestation.signature.event.content,
      tags: [...attestation.signature.event.tags, ["x", "ff".repeat(32)]],
    },
    Uint8Array.from(Buffer.from(TEST_NOSTR_PRIVATE_KEY, "hex")),
  );
  assert.equal(
    verifyCryptographicAttestation(
      {
        ...attestation,
        signature: { ...attestation.signature, event },
      },
      { issuerPublicKey: TEST_NOSTR_PUBLIC_KEY },
    ),
    false,
  );
});

test("rejects non-canonical NWC proofs before wallet lookup", async () => {
  let clientCreations = 0;
  const provider = createNwcSettlementProvider({
    name: "test-wallet",
    uri: () => "nostr+walletconnect://configured",
    clientFactory: () => {
      clientCreations += 1;
      return {
        makeInvoice: async () => {
          throw new Error("unused");
        },
        lookupInvoice: async () => {
          throw new Error("must not be called");
        },
        close() {},
      } as never;
    },
  });
  assert.equal(
    await provider.verifyPayment({
      paymentHash: PAYMENT_HASH,
      preimage: "AB".repeat(32),
      expectedAmountMsats: 5_000,
      expectedDescription: "test paid route",
      asset: "btc-lightning",
    }),
    "invalid",
  );
  assert.equal(clientCreations, 0);
});
