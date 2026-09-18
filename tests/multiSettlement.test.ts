import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createHttpAssetSettlementProvider,
  createMultiSettlementRouter,
} from "../artifacts/api-server/src/services/multiSettlement";
import {
  createSettlementRouter,
  SettlementProviderError,
  type SettlementProvider,
} from "../artifacts/api-server/src/services/settlement";
import {
  createSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../artifacts/api-server/src/lib/subscription-pass";
import { createMemoryPaymentChallengeStore } from "../artifacts/api-server/src/lib/payment-challenge-store";

const preimage = "ab".repeat(32);
const paymentHash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");

function provider(input: {
  name: string;
  configured?: boolean;
  createInvoice?: SettlementProvider["createInvoice"];
  verifyPayment?: SettlementProvider["verifyPayment"];
}): SettlementProvider {
  return {
    name: input.name,
    isConfigured: () => input.configured ?? true,
    createInvoice:
      input.createInvoice ??
      (async (request) => ({
        invoice: `${input.name}:${request.amountMsats}`,
        paymentHash,
        provider: input.name,
        asset: request.asset,
      })),
    verifyPayment:
      input.verifyPayment ??
      (async (request) => ({
        settledAt: 1_800_000_000,
        provider: input.name,
        asset: request.asset,
      })),
  };
}

function singleRouter(assetProvider: SettlementProvider, timeoutMs = 50) {
  return createSettlementRouter({
    primary: assetProvider,
    fallback: provider({
      name: `${assetProvider.name}-fallback`,
      configured: false,
    }),
    operationTimeoutMs: timeoutMs,
  });
}

test("generates unified Liquid and Taproot Asset invoices", async () => {
  const requests: Array<Record<string, unknown>> = [];
  for (const asset of ["l-btc", "taproot-assets"] as const) {
    const settlementProvider = createHttpAssetSettlementProvider({
      name: asset,
      asset,
      baseUrl: `https://${asset}.example`,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          invoice: `${asset}:invoice`,
          payment_hash: paymentHash,
        });
      },
    });
    const invoice = await settlementProvider.createInvoice({
      amountMsats: 25_000,
      description: "multi-asset pass",
      expirySeconds: 900,
      asset,
    });
    assert.deepEqual(invoice, {
      invoice: `${asset}:invoice`,
      paymentHash,
      provider: asset,
      asset,
    });
  }
  assert.deepEqual(
    requests.map((request) => request.asset),
    ["l-btc", "taproot-assets"],
  );
});

test("polls asset settlement and validates the exact payment proof", async () => {
  let polls = 0;
  const settledAt = Math.floor(Date.now() / 1_000);
  const liquid = createHttpAssetSettlementProvider({
    name: "liquid",
    asset: "l-btc",
    baseUrl: "https://liquid.example",
    pollIntervalMs: 1,
    fetch: async () => {
      polls += 1;
      return Response.json(
        polls === 1
          ? { status: "pending" }
          : {
              status: "settled",
              settled_at: settledAt,
              payment_hash: paymentHash,
              asset: "l-btc",
              amount_msats: 25_000,
              description: "multi-asset pass",
            },
      );
    },
  });
  const request = {
    paymentHash,
    preimage,
    expectedAmountMsats: 25_000,
    expectedDescription: "multi-asset pass",
    asset: "l-btc" as const,
  };
  assert.deepEqual(await liquid.verifyPayment(request), {
    settledAt,
    provider: "liquid",
    asset: "l-btc",
  });
  assert.equal(polls, 2);
  assert.equal(
    await liquid.verifyPayment({ ...request, preimage: "cd".repeat(32) }),
    "invalid",
  );
  assert.equal(polls, 2);
});

test("routes each asset independently and falls back within that asset", async () => {
  const liquid = createSettlementRouter({
    primary: provider({
      name: "liquid-primary",
      createInvoice: async () => {
        throw new SettlementProviderError("liquid unavailable", true);
      },
    }),
    fallback: provider({ name: "liquid-fallback" }),
  });
  const multi = createMultiSettlementRouter({
    lightning: singleRouter(provider({ name: "coinos" })),
    liquid,
    taprootAssets: singleRouter(provider({ name: "taproot-assets" })),
  });

  assert.deepEqual(multi.supportedAssets(), [
    "btc-lightning",
    "l-btc",
    "taproot-assets",
  ]);
  assert.equal(
    (
      await multi.createInvoice({
        amountMsats: 5_000,
        description: "test",
        expirySeconds: 60,
        asset: "l-btc",
      })
    ).provider,
    "liquid-fallback",
  );
  assert.equal(multi.activeProvider("l-btc"), "liquid-fallback");
  assert.equal(multi.activeProvider("btc-lightning"), "coinos");
});

test("falls back after an asset handler timeout", async () => {
  const liquid = createSettlementRouter({
    operationTimeoutMs: 5,
    primary: provider({
      name: "slow-liquid",
      createInvoice: () => new Promise(() => undefined),
    }),
    fallback: provider({ name: "liquid-fallback" }),
  });
  const invoice = await liquid.createInvoice({
    amountMsats: 5_000,
    description: "timeout",
    expirySeconds: 60,
    asset: "l-btc",
  });
  assert.equal(invoice.provider, "liquid-fallback");
});

test("never lets a fallback verify an invoice issued by the primary", async () => {
  let fallbackCalls = 0;
  const routed = createSettlementRouter({
    primary: provider({
      name: "liquid-primary",
      verifyPayment: async () => "invalid",
    }),
    fallback: provider({
      name: "liquid-fallback",
      verifyPayment: async (request) => {
        fallbackCalls += 1;
        return {
          settledAt: 1_800_000_000,
          provider: "liquid-fallback",
          asset: request.asset,
        };
      },
    }),
  });
  assert.equal(
    await routed.verifyPayment({
      paymentHash,
      preimage,
      expectedAmountMsats: 25_000,
      expectedDescription: "multi-asset pass",
      expectedProvider: "liquid-primary",
      asset: "l-btc",
    }),
    "invalid",
  );
  assert.equal(fallbackCalls, 0);
});

test("binds and validates the payment_asset macaroon caveat", () => {
  const secret = "multi-settlement-test-secret";
  const macaroon = createSubscriptionMacaroon({
    secret,
    paymentHash,
    tier: "1-day",
    validUntil: 1_900_000_000,
    amountMsats: 25_000,
    paymentAsset: "taproot-assets",
    paymentProvider: "taproot-assets",
  });
  const verified = verifySubscriptionMacaroon(
    macaroon,
    secret,
    1_800_000_000,
  );
  assert.equal(verified?.paymentAsset, "taproot-assets");

  const decoded = JSON.parse(
    Buffer.from(macaroon, "base64url").toString("utf8"),
  );
  decoded.caveats = decoded.caveats.map((caveat: string) =>
    caveat === "payment_asset=taproot-assets"
      ? "payment_asset=l-btc"
      : caveat,
  );
  const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  assert.equal(
    verifySubscriptionMacaroon(tampered, secret, 1_800_000_000),
    null,
  );
});

test("expires in-memory legacy issuer bindings at the redemption deadline", async () => {
  let now = 1_800_000_000_000;
  const store = createMemoryPaymentChallengeStore();
  const challenge = {
    invoice: "liquid:invoice",
    paymentHash,
    provider: "liquid",
    asset: "l-btc" as const,
    issuedAt: now,
    redeemUntil: now + 3_600_000,
  };
  await store.getOrCreate(
    "caller",
    "scope",
    {
      now: () => now,
      reuseMs: 300_000,
      limitWindowMs: 3_600_000,
      maxInvoicesPerWindow: 5,
      maxCallers: 100,
    },
    async () => challenge,
  );
  assert.equal(
    (await store.findByPaymentHash("caller", paymentHash))?.provider,
    "liquid",
  );
  now = challenge.redeemUntil;
  assert.equal(await store.findByPaymentHash("caller", paymentHash), null);
});