import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateEscrowToll, createEscrowPriceReader, escrowTollQuote } from "./escrowPricing";
import { readLiveBitcoinUsdPrice } from "./stratigraphy-stream";

test("USD toll vectors match Python including hyper-appreciation, ties and one-sat floor", () => {
  for (const [price, expected] of [
    [100_000, 20], [150_000, 13], [50_000, 40],
    [1_000_000, 2], [2_000_000, 1], [100_000_000, 1], [800_000, 2],
  ]) assert.equal(calculateEscrowToll(price), expected);
});

test("invalid or unrepresentable rates use exactly 21 sats, not a zero or stale fee", () => {
  for (const price of [null, undefined, 0, -1, true, "100000", NaN, Infinity, 1e-300]) {
    const quote = escrowTollQuote(price);
    assert.equal(quote.toll_fee_sats, 21);
    assert.equal(quote.source, "fallback");
    assert.equal(quote.btc_usd_price, null);
  }
  assert.equal(calculateEscrowToll(1e308), 1);
});

test("concurrent price requests share one read and cache expires after 15 seconds", async () => {
  let calls = 0;
  let now = 0;
  const reader = createEscrowPriceReader(async () => { calls++; return 1_000_000; }, () => now);
  assert.deepEqual(await Promise.all([reader(), reader(), reader()]), [1_000_000, 1_000_000, 1_000_000]);
  assert.equal(calls, 1);
  now = 14_999;
  await reader();
  assert.equal(calls, 1);
  now = 15_000;
  await reader();
  assert.equal(calls, 2);
});

test("feed failure discards expired market quote and recovers after short failure TTL", async () => {
  let now = 0;
  let mode = 0;
  let calls = 0;
  const reader = createEscrowPriceReader(async () => {
    calls++;
    if (mode === 1) throw new Error("offline");
    return mode === 2 ? 2_000_000 : 100_000;
  }, () => now);
  assert.equal(await reader(), 100_000);
  mode = 1; now = 15_000;
  assert.equal(await reader(), null);
  assert.equal(escrowTollQuote(await reader()).toll_fee_sats, 21);
  assert.equal(calls, 2);
  mode = 2; now = 17_000;
  assert.equal(await reader(), 2_000_000);
});

test("existing market rail uses mempool prices with bounded body and an abort signal", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (
    url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1],
  ) => {
    assert.equal(url, "https://mempool.space/api/v1/prices");
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ USD: 1_000_000 }));
  });
  assert.equal(await readLiveBitcoinUsdPrice(), 1_000_000);
  mock.mock.mockImplementation(async () => new Response("x".repeat(64 * 1024 + 1)));
  await assert.rejects(readLiveBitcoinUsdPrice(), /exceeded/);
});
