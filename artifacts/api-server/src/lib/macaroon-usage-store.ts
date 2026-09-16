export interface MacaroonUsageStore {
  consume(
    limits: Array<{ tokenId: string; maxRequests: number }>,
    validUntil: number,
  ): Promise<boolean>;
}

export function createMemoryMacaroonUsageStore(): MacaroonUsageStore {
  const counts = new Map<string, number>();
  let pending: Promise<void> = Promise.resolve();
  return {
    async consume(limits) {
      let resolveOperation!: () => void;
      const operationDone = new Promise<void>((resolve) => {
        resolveOperation = resolve;
      });
      const previous = pending;
      pending = operationDone;
      await previous;
      const allowed = limits.every(
        ({ tokenId, maxRequests }) =>
          (counts.get(tokenId) ?? 0) < maxRequests,
      );
      if (allowed) {
        for (const { tokenId } of limits) {
          counts.set(tokenId, (counts.get(tokenId) ?? 0) + 1);
        }
      }
      resolveOperation();
      return allowed;
    },
  };
}