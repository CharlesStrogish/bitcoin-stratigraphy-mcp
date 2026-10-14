import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createL402Middleware } from "../../src/middleware/l402";
import { createMemoryRevenueLedger } from "../../src/services/ledger";
import { createSettlementRouter } from "../../src/services/settlement";
import { createNwcSettlementProvider } from "../../src/services/settlement/nwc-provider";

const invoice = "lnbc-coinos-internal";
const preimage = "11".repeat(32);
const paymentHash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");
const uuid = "123e4567-e89b-12d3-a456-426614174000";
const amount = 10_000;
const settledAt = Math.floor(Date.now() / 1_000);
const description = "Paid tool";

function fixture(
  options: { crossAccount?: boolean; payerConfigured?: boolean } = {},
) {
  const incoming = {
    type: "incoming",
    state: "settled",
    payment_hash: paymentHash,
    invoice,
    description,
    amount: 0,
    preimage: "sender-account-id",
    settled_at: settledAt,
  };
  const credited = {
    type: "incoming",
    state: "settled",
    payment_hash: "internal-credit-id",
    invoice,
    amount,
    created_at: settledAt,
  };
  const outgoing = {
    type: "outgoing",
    state: "settled",
    payment_hash: uuid,
    invoice,
    amount,
    created_at: settledAt,
  };
  let lookups = 0;
  let listings = 0;
  const coinos = createNwcSettlementProvider({
    name: "coinos",
    uri: () => "nostr+walletconnect://issuer",
    payerUri: () =>
      options.payerConfigured ? "nostr+walletconnect://payer" : undefined,
    clientFactory: (uri) => ({
      makeInvoice: async () =>
        ({ invoice, payment_hash: paymentHash }) as never,
      lookupInvoice: async () => {
        lookups++;
        return incoming as never;
      },
      listTransactions: async ({ type }) => {
        listings++;
        return {
          transactions:
            type === "incoming"
              ? uri.endsWith("//issuer")
                ? [credited]
                : []
              : options.crossAccount && uri.endsWith("//issuer")
                ? []
                : [outgoing],
        } as never;
      },
      close: () => {},
    }),
  });
  const alby = createNwcSettlementProvider({
    name: "alby",
    uri: () => "nostr+walletconnect://test",
    clientFactory: () => ({
      makeInvoice: async () =>
        ({ invoice, payment_hash: paymentHash }) as never,
      lookupInvoice: async () => incoming as never,
      close: () => {},
    }),
  });
  const router = createSettlementRouter({ primary: coinos, fallback: alby });
  const verify = (reference = uuid) =>
    router.verifyPayment({
      paymentHash,
      preimage: reference,
      expectedAmountMsats: amount,
      expectedDescription: description,
      expectedProvider: "coinos",
      asset: "btc-lightning",
    });
  return {
    incoming,
    credited,
    outgoing,
    coinos,
    router,
    verify,
    counts: () => ({ lookups, listings }),
  };
}

test("a separate CoinOS payer must be visible through the configured payer wallet", async () => {
  assert.equal(await fixture({ crossAccount: true }).verify(), "invalid");
  const { outgoing, verify, counts } = fixture({
    crossAccount: true,
    payerConfigured: true,
  });
  assert.deepEqual(await verify(), {
    settledAt,
    provider: "coinos",
    asset: "btc-lightning",
  });
  assert.deepEqual(counts(), { lookups: 1, listings: 3 });
  outgoing.invoice = "lnbc-other";
  assert.equal(await verify(), "invalid");
});

test("CoinOS UUID requires the exact outgoing payment and settled incoming invoice", async () => {
  const { incoming, credited, outgoing, coinos, verify } = fixture();
  assert.deepEqual(
    await coinos.verifyPayment({
      paymentHash,
      preimage: uuid,
      expectedAmountMsats: amount,
      expectedDescription: description,
      asset: "btc-lightning",
    }),
    { settledAt, provider: "coinos", asset: "btc-lightning" },
  );
  assert.deepEqual(await verify(), {
    settledAt,
    provider: "coinos",
    asset: "btc-lightning",
  });
  outgoing.invoice = "lnbc-other";
  assert.equal(await verify(), "invalid");
  outgoing.invoice = invoice;
  outgoing.payment_hash = "223e4567-e89b-12d3-a456-426614174000";
  assert.equal(await verify(), "invalid");
  outgoing.payment_hash = uuid;
  outgoing.amount = 9_000;
  assert.equal(await verify(), "invalid");
  outgoing.amount = amount;
  outgoing.state = "pending";
  assert.equal(await verify(), "invalid");
  outgoing.state = "settled";
  credited.amount = 9_000;
  assert.equal(await verify(), "invalid");
  credited.amount = amount;
  incoming.description = "another product";
  assert.equal(await verify(), "invalid");
  incoming.description = description;
  incoming.state = "pending";
  assert.equal(await verify(), "invalid");
  incoming.state = "settled";
  assert.equal(await verify("223e4567-e89b-12d3-a456-426614174000"), "invalid");
  assert.equal(
    await verify("any-string-of-thirty-six-characters!!"),
    "invalid",
  );
  incoming.preimage = preimage;
  incoming.amount = amount;
  assert.deepEqual(await verify(preimage), {
    settledAt,
    provider: "coinos",
    asset: "btc-lightning",
  });
  assert.equal(
    await coinos.verifyPayment({
      paymentHash,
      preimage: uuid,
      expectedAmountMsats: amount,
      expectedDescription: description,
      asset: "l-btc",
    }),
    "invalid",
  );
});

test("L402 UUID lookup hints require a valid macaroon and confirmed merchant credit, not payer-side access", async () => {
  const { router, counts } = fixture();
  const ledger = createMemoryRevenueLedger();
  const app = express();
  app.get(
    "/paid",
    createL402Middleware({
      amountSats: 10,
      description,
      settlementRouter: router,
      sessionSecret: "test-only-secret",
      ledger,
      scopePath: "/paid",
    }),
    (_req, res) => res.json({ paid: true }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/paid`;
    const challenge = await fetch(url);
    assert.equal(challenge.status, 402);
    const { macaroon } = (await challenge.json()) as { macaroon: string };
    const wrong = await fetch(url, {
      headers: {
        Authorization: `L402 ${macaroon}tampered:223e4567-e89b-12d3-a456-426614174000`,
      },
    });
    assert.equal(wrong.status, 402);
    const paid = await fetch(url, {
      headers: { Authorization: `L402 ${macaroon}:${uuid}` },
    });
    assert.equal(paid.status, 200);
    assert.deepEqual(await paid.json(), { paid: true });
    assert.equal(await ledger.getTotalVolume(), 10);
    assert.deepEqual(counts(), { lookups: 1, listings: 1 });
    const replay = await fetch(url, {
      headers: { Authorization: `L402 ${macaroon}:${uuid}` },
    });
    assert.equal(replay.status, 429);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
