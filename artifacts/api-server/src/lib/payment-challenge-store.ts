export type PaymentChallenge = { invoice: string; paymentHash: string };

export type ChallengeStorePolicy = {
  now: () => number;
  reuseMs: number;
  limitWindowMs: number;
  maxInvoicesPerWindow: number;
  maxCallers: number;
};

export type ChallengeStoreResult =
  | { kind: "challenge"; challenge: PaymentChallenge }
  | { kind: "limited"; retryAfter: number };

export interface PaymentChallengeStore {
  checkHealth(): Promise<void>;
  getOrCreate(
    caller: string,
    policy: ChallengeStorePolicy,
    create: () => Promise<PaymentChallenge>,
  ): Promise<ChallengeStoreResult>;
  consume(caller: string, paymentHash: string): Promise<void>;
}

type StoredState = {
  challenge?: PaymentChallenge;
  challengeExpiresAt: number;
  invoiceAttemptedAt: number[];
};

function retryAfter(now: number, oldestAttempt: number, windowMs: number) {
  return Math.max(1, Math.ceil((windowMs - (now - oldestAttempt)) / 1000));
}

export function createMemoryPaymentChallengeStore(): PaymentChallengeStore {
  const states = new Map<string, StoredState>();
  const pending = new Map<string, Promise<ChallengeStoreResult>>();

  return {
    async checkHealth() {},
    async getOrCreate(caller, policy, create) {
      const existingPending = pending.get(caller);
      if (existingPending) return existingPending;

      const operation = (async () => {
        const now = policy.now();
        for (const [key, state] of states) {
          const newestAttempt = state.invoiceAttemptedAt.at(-1) ?? 0;
          if (
            state.challengeExpiresAt <= now &&
            newestAttempt + policy.limitWindowMs <= now
          ) {
            states.delete(key);
          }
        }

        let state = states.get(caller);
        if (!state) {
          if (states.size >= policy.maxCallers) {
            return { kind: "limited", retryAfter: 60 } as const;
          }
          state = {
            challengeExpiresAt: 0,
            invoiceAttemptedAt: [],
          };
          states.set(caller, state);
        }

        state.invoiceAttemptedAt = state.invoiceAttemptedAt.filter(
          (attemptedAt) => now - attemptedAt < policy.limitWindowMs,
        );
        if (state.challenge && state.challengeExpiresAt > now) {
          return { kind: "challenge", challenge: state.challenge } as const;
        }
        if (
          state.invoiceAttemptedAt.length >= policy.maxInvoicesPerWindow
        ) {
          return {
            kind: "limited",
            retryAfter: retryAfter(
              now,
              state.invoiceAttemptedAt[0],
              policy.limitWindowMs,
            ),
          } as const;
        }

        state.invoiceAttemptedAt.push(now);
        const challenge = await create();
        state.challenge = challenge;
        state.challengeExpiresAt = policy.now() + policy.reuseMs;
        return { kind: "challenge", challenge } as const;
      })();
      pending.set(caller, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(caller) === operation) pending.delete(caller);
      }
    },
    async consume(caller, paymentHash) {
      const state = states.get(caller);
      if (state?.challenge?.paymentHash === paymentHash) states.delete(caller);
    },
  };
}
