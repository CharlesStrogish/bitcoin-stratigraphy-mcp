// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.

/** Determine mode without needing balance-read permission on a restricted key. */
export function fiatStripeKeyLivemode(key: string): boolean {
  const match = /^(?:sk|rk)_(test|live)_[A-Za-z0-9_]+$/.exec(key);
  if (!match) throw new Error("Expected a Stripe secret or restricted API key");
  return match[1] === "live";
}

/** Live spending requires separate approval; old test flags grant no live authority. */
export function fiatTreasuryPolicy(
  livemode: boolean,
  env: Record<string, string | undefined>,
) {
  const primary = env.FIAT_MINT_TREASURY_BUDGET_SATS;
  const alternate = env.FIAT_MINT_BUDGET_TREASURY_SATS;
  const conflicting =
    primary !== undefined &&
    alternate !== undefined &&
    Number(primary) !== Number(alternate);
  return {
    allowed:
      (livemode
        ? env.FIAT_MINT_ALLOW_TREASURY
        : env.FIAT_MINT_ALLOW_TEST_TREASURY) === "true",
    // An invalid budget is rejected by both live admission and funding checks.
    budgetSats:
      livemode && conflicting
        ? Number.NaN
        : Number(
            (livemode
              ? (primary ?? alternate)
              : env.FIAT_MINT_TEST_TREASURY_BUDGET_SATS) ?? 0,
          ),
  };
}
