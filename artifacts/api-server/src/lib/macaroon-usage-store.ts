export interface MacaroonUsageStore {
  consume(
    limits: Array<{ tokenId: string; maxRequests: number }>,
    validUntil: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export function createMemoryMacaroonUsageStore(
  now: () => number = Date.now,
): MacaroonUsageStore {
  const counts = new Map<string, { count: number; validUntil: number }>();
  let pending: Promise<void> = Promise.resolve();
  return {
    async consume(limits, validUntil, signal) {
      let resolveOperation!: () => void;
      const operationDone = new Promise<void>((resolve) => {
        resolveOperation = resolve;
      });
      const previous = pending;
      pending = operationDone;
      await previous;
      if (signal?.aborted) {
        resolveOperation();
        throw signal.reason;
      }
      const nowSeconds = Math.floor(now() / 1_000);
      for (const [tokenId, usage] of counts) {
        if (usage.validUntil <= nowSeconds) counts.delete(tokenId);
      }
      const allowed = limits.every(
        ({ tokenId, maxRequests }) =>
          (counts.get(tokenId)?.count ?? 0) < maxRequests,
      );
      if (allowed) {
        for (const { tokenId } of limits) {
          counts.set(tokenId, {
            count: (counts.get(tokenId)?.count ?? 0) + 1,
            validUntil,
          });
        }
      }
      resolveOperation();
      return allowed;
    },
  };
}
