/** Bounded process-local invoice-admission pressure; never a source of randomness. */
export function createThermodynamicPricing(now: () => number = Date.now) {
  let startedAt = now();
  let admitted = 0;
  return (baseFeeSats: number, batchSize = 1, fixedAmount = false) => {
    const time = now();
    if (time < startedAt || time - startedAt >= 60_000) {
      startedAt = time;
      admitted = 0;
    }
    admitted = Math.min(600, admitted + 1);
    // Base price through 120 admitted challenges/minute, capped at 3x at 600.
    const pressureSteps = fixedAmount ? 0 : Math.max(0, admitted - 120);
    const multiplier = 1 + pressureSteps / 240;
    const baseAmountSats = baseFeeSats * batchSize;
    if (!Number.isSafeInteger(baseAmountSats) || baseAmountSats <= 0) {
      throw new RangeError("Thermodynamic base fee must be a positive safe integer");
    }
    const amountSats = Number(
      (BigInt(baseAmountSats) * BigInt(240 + pressureSteps) + 239n) / 240n,
    );
    if (!Number.isSafeInteger(amountSats * 1000)) {
      throw new RangeError("Thermodynamic fee exceeds safe millisatoshi range");
    }
    return {
      baseAmountSats,
      amountSats,
      multiplier,
      // Integer numerator preserves the exact hundredth-sat allocation, without flooring.
      yieldGuaranteeSats: (amountSats * 21) / 100,
    };
  };
}
