import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateTierCost,
  createPricingEngine,
  STATIC_TIER_PRICING,
} from "../../src/services/pricing";

test("returns backward-compatible base prices when signals are omitted", () => {
  assert.equal(calculateTierCost("1-day").priceSats, 5);
  assert.equal(calculateTierCost("30-day").priceSats, 100);
});

test("keeps low-demand early-epoch pricing at the base", () => {
  assert.equal(calculateTierCost("1-day", 50, 120).priceSats, 5);
  assert.equal(calculateTierCost("30-day", 75, 0).priceSats, 100);
});

test("reaches but never exceeds tier ceilings", () => {
  for (const tier of ["1-day", "30-day"] as const) {
    const quote = calculateTierCost(tier, 1000, 100_000);
    assert.equal(quote.priceSats, STATIC_TIER_PRICING[tier].maxSats);
    assert.equal(
      quote.multiplier,
      STATIC_TIER_PRICING[tier].maxSats /
        STATIC_TIER_PRICING[tier].baseSats,
    );
  }
});

test("scales during either late-epoch or high-demand periods", () => {
  assert.ok(calculateTierCost("1-day", 90, 0).priceSats > 5);
  assert.ok(calculateTierCost("30-day", 0, 400).priceSats > 100);
});

test("clamps invalid and negative input signals safely", () => {
  assert.equal(calculateTierCost("1-day", Number.NaN, -10).priceSats, 5);
  assert.equal(calculateTierCost("30-day", -100, Number.NaN).priceSats, 100);
});

test("tracks rolling request velocity and expires old observations", () => {
  let now = 1_000_000;
  const engine = createPricingEngine({ now: () => now });
  for (let index = 0; index < 200; index += 1) engine.recordRequest();
  assert.equal(engine.requestVelocity(), 200);
  assert.ok(engine.quote("1-day", 0).priceSats > 5);
  now += 60_001;
  assert.equal(engine.requestVelocity(), 0);
  assert.equal(engine.quote("1-day", 0).priceSats, 5);
});