import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { pool } from "@workspace/db";
import { createMemoryPaymentChallengeStore } from "../../src/lib/payment-challenge-store";
import { createPostgresPaymentChallengeStore } from "../../src/lib/postgres-payment-challenge-store";
import { registerStratigraphyRoutes } from "../../src/routes/stratigraphy";
import { calculateTierCost } from "../../src/services/pricing";
import { createCoinosSettlementProvider } from "../../src/services/settlement/coinos";
import {
  createSettlementRouter,
  SettlementProviderError,
  type SettlementProvider,
  type SettlementRouter,
} from "../../src/services/settlement";

const invoice = (provider: string, sequence = 1) => ({
  invoice: `lnbc-${provider}-${sequence}`,
  paymentHash: createHash("sha256")
    .update(`${provider}:${sequence}`)
    .digest("hex"),
  provider,
});

function provider(input: {
  name: string;
  createInvoice?: SettlementProvider["createInvoice"];
  verifyPayment?: SettlementProvider["verifyPayment"];
}): SettlementProvider {
  return {
    name: input.name,
    isConfigured: () => true,
    createInvoice:
      input.createInvoice ??
      (async () => invoice(input.name)),
    verifyPayment:
      input.verifyPayment ??
      (async () => ({
        settledAt: 1_800_000_000,
        provider: input.name,
      })),
  };
}

test("fails over immediately on a Coinos network or 5xx error", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const router = createSettlementRouter({
    primary: provider({
      name: "coinos",
      createInvoice: async () => {
        primaryCalls += 1;
        throw new SettlementProviderError("Coinos HTTP 503", true);
      },
    }),
    fallback: provider({
      name: "alby",
      createInvoice: async () => {
        fallbackCalls += 1;
        return invoice("alby", fallbackCalls);
      },
    }),
  });

  assert.equal((await router.createInvoice({
    amountMsats: 5_000,
    description: "test",
    expirySeconds: 3600,
  })).provider, "alby");
  assert.equal(router.circuitState(), "open");
  assert.equal(router.activeProvider(), "alby");

  await router.createInvoice({
    amountMsats: 5_000,
    description: "test",
    expirySeconds: 3600,
  });
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 2);
});

test("fails over when Coinos exceeds the operation timeout", async () => {
  const router = createSettlementRouter({
    operationTimeoutMs: 5,
    primary: provider({
      name: "coinos",
      createInvoice: () => new Promise(() => undefined),
    }),
    fallback: provider({ name: "alby" }),
  });
  const result = await router.createInvoice({
    amountMsats: 5_000,
    description: "test",
    expirySeconds: 3600,
  });
  assert.equal(result.provider, "alby");
  assert.equal(router.circuitState(), "open");
});

test("classifies a raw Coinos HTTP 5xx response and closes its client", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  process.env.NWC_URI = "nostr+walletconnect://coinos";
  let closeCalls = 0;
  const primary = createCoinosSettlementProvider(() => ({
    makeInvoice: async () => {
      throw Object.assign(new Error("upstream unavailable"), { status: 503 });
    },
    lookupInvoice: async () => {
      throw new Error("unused");
    },
    close: () => {
      closeCalls += 1;
    },
  }) as never);
  const router = createSettlementRouter({
    primary,
    fallback: provider({ name: "alby" }),
  });
  try {
    assert.equal(
      (await router.createInvoice({
        amountMsats: 5_000,
        description: "test",
        expirySeconds: 3600,
      })).provider,
      "alby",
    );
    assert.equal(closeCalls, 1);
    assert.equal(router.circuitState(), "open");
  } finally {
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
  }
});

test("closes the Coinos NWC client when the router timeout fires", async () => {
  const configuredNwcUri = process.env.NWC_URI;
  process.env.NWC_URI = "nostr+walletconnect://coinos";
  let closeCalls = 0;
  const primary = createCoinosSettlementProvider(() => ({
    makeInvoice: () => new Promise(() => undefined),
    lookupInvoice: async () => {
      throw new Error("unused");
    },
    close: () => {
      closeCalls += 1;
    },
  }) as never);
  const router = createSettlementRouter({
    operationTimeoutMs: 5,
    primary,
    fallback: provider({ name: "alby" }),
  });
  try {
    assert.equal(
      (await router.createInvoice({
        amountMsats: 5_000,
        description: "test",
        expirySeconds: 3600,
      })).provider,
      "alby",
    );
    assert.equal(closeCalls, 1);
  } finally {
    if (configuredNwcUri === undefined) delete process.env.NWC_URI;
    else process.env.NWC_URI = configuredNwcUri;
  }
});

test("opens after three consecutive non-network primary failures", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const router = createSettlementRouter({
    primary: provider({
      name: "coinos",
      createInvoice: async () => {
        primaryCalls += 1;
        throw new SettlementProviderError("invalid Coinos response", false);
      },
    }),
    fallback: provider({
      name: "alby",
      createInvoice: async () => {
        fallbackCalls += 1;
        return invoice("alby");
      },
    }),
  });
  const request = {
    amountMsats: 5_000,
    description: "test",
    expirySeconds: 3600,
  };

  await assert.rejects(router.createInvoice(request));
  await assert.rejects(router.createInvoice(request));
  assert.equal((await router.createInvoice(request)).provider, "alby");
  assert.equal(primaryCalls, 3);
  assert.equal(fallbackCalls, 1);
  assert.equal(router.circuitState(), "open");
});

test("probes and restores Coinos after the five-minute cooldown", async () => {
  let now = 1_000_000;
  let primaryHealthy = false;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const router = createSettlementRouter({
    now: () => now,
    primary: provider({
      name: "coinos",
      createInvoice: async () => {
        primaryCalls += 1;
        if (!primaryHealthy) {
          throw new SettlementProviderError("network unavailable", true);
        }
        return invoice("coinos", primaryCalls);
      },
    }),
    fallback: provider({
      name: "alby",
      createInvoice: async () => {
        fallbackCalls += 1;
        return invoice("alby", fallbackCalls);
      },
    }),
  });
  const request = {
    amountMsats: 100_000,
    description: "test",
    expirySeconds: 3600,
  };

  assert.equal((await router.createInvoice(request)).provider, "alby");
  now += 299_999;
  assert.equal((await router.createInvoice(request)).provider, "alby");
  assert.equal(primaryCalls, 1);

  primaryHealthy = true;
  now += 2;
  assert.equal((await router.createInvoice(request)).provider, "coinos");
  assert.equal(router.circuitState(), "closed");
  assert.equal(router.activeProvider(), "coinos");
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 2);
});

test("routes payment verification through the fallback during an outage", async () => {
  const router = createSettlementRouter({
    primary: provider({
      name: "coinos",
      verifyPayment: async () => {
        throw new SettlementProviderError("Coinos timeout", true);
      },
    }),
    fallback: provider({
      name: "alby",
      verifyPayment: async () => ({
        settledAt: 1_800_000_000,
        provider: "alby",
      }),
    }),
  });

  assert.deepEqual(
    await router.verifyPayment({
      paymentHash: "a".repeat(64),
      preimage: "b".repeat(64),
      expectedAmountMsats: 5_000,
      expectedDescription: "test",
    }),
    { settledAt: 1_800_000_000, provider: "alby" },
  );
  assert.equal(router.circuitState(), "open");
});

test("still verifies a fallback invoice after Coinos recovers", async () => {
  let now = 1_000_000;
  let primaryHealthy = false;
  const router = createSettlementRouter({
    now: () => now,
    primary: provider({
      name: "coinos",
      createInvoice: async () => {
        throw new SettlementProviderError("Coinos network unavailable", true);
      },
      verifyPayment: async () =>
        primaryHealthy
          ? "invalid"
          : Promise.reject(
              new SettlementProviderError("Coinos unavailable", true),
            ),
    }),
    fallback: provider({
      name: "alby",
      createInvoice: async () => invoice("alby"),
      verifyPayment: async () => ({
        settledAt: 1_800_000_000,
        provider: "alby",
      }),
    }),
  });
  const request = {
    amountMsats: 5_000,
    description: "test",
    expirySeconds: 3600,
  };
  assert.equal((await router.createInvoice(request)).provider, "alby");

  now += 300_001;
  primaryHealthy = true;
  assert.deepEqual(
    await router.verifyPayment({
      paymentHash: invoice("alby").paymentHash,
      preimage: "a".repeat(64),
      expectedAmountMsats: request.amountMsats,
      expectedDescription: request.description,
    }),
    { settledAt: 1_800_000_000, provider: "alby" },
  );
  assert.equal(router.circuitState(), "closed");
});

test("allows only one Coinos verification probe while half-open", async () => {
  let now = 1_000_000;
  let primaryVerificationCalls = 0;
  let releaseProbe!: () => void;
  let probeStarted!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const probeEntered = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  const router = createSettlementRouter({
    now: () => now,
    primary: provider({
      name: "coinos",
      createInvoice: async () => {
        throw new SettlementProviderError("Coinos unavailable", true);
      },
      verifyPayment: async () => {
        primaryVerificationCalls += 1;
        probeStarted();
        await probeGate;
        return { settledAt: 1_800_000_000, provider: "coinos" };
      },
    }),
    fallback: provider({
      name: "alby",
      verifyPayment: async () => "invalid",
    }),
  });
  await router.createInvoice({
    amountMsats: 5_000,
    description: "test",
    expirySeconds: 3600,
  });
  now += 300_001;
  const verification = {
    paymentHash: "a".repeat(64),
    preimage: "b".repeat(64),
    expectedAmountMsats: 5_000,
    expectedDescription: "test",
  };
  const first = router.verifyPayment(verification);
  await probeEntered;
  assert.equal(await router.verifyPayment(verification), "unavailable");
  assert.equal(primaryVerificationCalls, 1);
  releaseProbe();
  assert.deepEqual(await first, {
    settledAt: 1_800_000_000,
    provider: "coinos",
  });
  assert.equal(router.circuitState(), "closed");
});

test("builds every L402 challenge with the active fallback provider", async () => {
  let sequence = 0;
  const settlementRouter: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "alby",
    circuitState: () => "open",
    createInvoice: async () => invoice("alby", ++sequence),
    verifyPayment: async () => "invalid",
  };
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
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
    {
      recordRequest: () => undefined,
      requestVelocity: () => 0,
      quote: (tier) => calculateTierCost(tier),
    },
    settlementRouter,
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/stratigraphy?days=1`,
    );
    assert.equal(response.status, 402);
    assert.match(response.headers.get("www-authenticate") ?? "", /lnbc-alby-1/);
    assert.match(response.headers.get("www-authenticate") ?? "", /lnbc-alby-2/);
    assert.match(response.headers.get("www-authenticate") ?? "", /lnbc-alby-3/);
    const body = await response.json() as {
      invoice: string;
      passes: Array<{ invoice: string }>;
    };
    assert.equal(body.invoice, "lnbc-alby-1");
    assert.deepEqual(
      body.passes.map(({ invoice: passInvoice }) => passInvoice),
      ["lnbc-alby-2", "lnbc-alby-3"],
    );
  } finally {
    server.close();
  }
});

test("attributes failover challenges to the actual provider cache", async () => {
  let fallbackInvoices = 0;
  let primaryCalls = 0;
  const settlementRouter = createSettlementRouter({
    primary: provider({
      name: "coinos",
      createInvoice: async () => {
        primaryCalls += 1;
        throw new SettlementProviderError("Coinos HTTP 503", true);
      },
    }),
    fallback: provider({
      name: "alby",
      createInvoice: async () => invoice("alby", ++fallbackInvoices),
    }),
  });
  const app = express();
  app.use((req, _res, next) => {
    (req as any).log = { error: () => undefined };
    next();
  });
  registerStratigraphyRoutes(
    app,
    undefined,
    undefined,
    createMemoryPaymentChallengeStore(),
    undefined,
    undefined,
    {
      recordRequest: () => undefined,
      requestVelocity: () => 0,
      quote: (tier) => calculateTierCost(tier),
    },
    settlementRouter,
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const url =
    `http://127.0.0.1:${address.port}/api/v1/stratigraphy?days=1`;
  try {
    const failedOver = await fetch(url);
    assert.equal(failedOver.status, 402);
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackInvoices, 3);
    const body = await failedOver.json() as {
      invoice: string;
      passes: Array<{ invoice: string }>;
    };
    assert.match(body.invoice, /lnbc-alby-/);
    assert.ok(body.passes.every(({ invoice }) => invoice.includes("alby")));

    const reusedFallback = await fetch(url);
    assert.equal(reusedFallback.status, 402);
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackInvoices, 3);
  } finally {
    server.close();
  }
});

test("deduplicates concurrent PostgreSQL failover under stale provider scopes", async () => {
  const caller = `settlement-failover-${Date.now()}`;
  const predictedScope = "range:settlement:coinos";
  const firstStore = createPostgresPaymentChallengeStore();
  const secondStore = createPostgresPaymentChallengeStore();
  const policy = {
    now: Date.now,
    reuseMs: 5 * 60 * 1000,
    limitWindowMs: 60 * 60 * 1000,
    maxInvoicesPerWindow: 5,
    maxCallers: 10_000,
  };
  let creations = 0;
  const create = async () => {
    creations += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ...invoice("alby", creations),
      issuedAt: Date.now(),
    };
  };
  const finalScope = (challenge: { provider?: string }) =>
    `range:settlement:${challenge.provider ?? "coinos"}`;

  try {
    const [first, second] = await Promise.all([
      firstStore.getOrCreate(
        caller,
        predictedScope,
        policy,
        create,
        finalScope,
      ),
      secondStore.getOrCreate(
        caller,
        predictedScope,
        policy,
        create,
        finalScope,
      ),
    ]);
    assert.equal(first.kind, "challenge");
    assert.equal(second.kind, "challenge");
    assert.equal(creations, 1);
    if (first.kind === "challenge" && second.kind === "challenge") {
      assert.equal(
        first.challenge.paymentHash,
        second.challenge.paymentHash,
      );
    }
  } finally {
    await pool.query(
      "DELETE FROM payment_range_challenges WHERE caller_key = $1",
      [caller],
    );
    await pool.query(
      "DELETE FROM payment_challenges WHERE caller_key = $1",
      [caller],
    );
  }
});