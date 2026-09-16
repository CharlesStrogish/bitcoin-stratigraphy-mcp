export type PaymentChallenge = {
  invoice: string;
  paymentHash: string;
  issuedAt: number;
  provider?: string;
};

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
    scope: string,
    policy: ChallengeStorePolicy,
    create: () => Promise<PaymentChallenge>,
    scopeForChallenge?: (challenge: PaymentChallenge) => string,
  ): Promise<ChallengeStoreResult>;
  consume(caller: string, scope: string, paymentHash: string): Promise<void>;
}

type StoredState = {
  challenges: Map<
    string,
    { challenge: PaymentChallenge; expiresAt: number }
  >;
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
    async getOrCreate(caller, scope, policy, create, scopeForChallenge) {
      const pendingKey = `${caller}|${scope}`;
      const existingPending = pending.get(pendingKey);
      if (existingPending) return existingPending;

      const operation = (async () => {
        const now = policy.now();
        for (const [key, state] of states) {
          for (const [scope, stored] of state.challenges) {
            if (stored.expiresAt <= now) state.challenges.delete(scope);
          }
          const newestAttempt = state.invoiceAttemptedAt.at(-1) ?? 0;
          if (
            state.challenges.size === 0 &&
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
            challenges: new Map(),
            invoiceAttemptedAt: [],
          };
          states.set(caller, state);
        }

        state.invoiceAttemptedAt = state.invoiceAttemptedAt.filter(
          (attemptedAt) => now - attemptedAt < policy.limitWindowMs,
        );
        const existing = state.challenges.get(scope);
        if (existing && existing.expiresAt > now) {
          return { kind: "challenge", challenge: existing.challenge } as const;
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
        const finalScope = scopeForChallenge?.(challenge) ?? scope;
        const stored = {
          challenge,
          expiresAt: policy.now() + policy.reuseMs,
        };
        state.challenges.set(finalScope, stored);
        if (finalScope !== scope) state.challenges.set(scope, stored);
        return { kind: "challenge", challenge } as const;
      })();
      pending.set(pendingKey, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(pendingKey) === operation) pending.delete(pendingKey);
      }
    },
    async consume(caller, scope, paymentHash) {
      const state = states.get(caller);
      for (const [storedScope, stored] of state?.challenges ?? []) {
        if (
          (storedScope === scope ||
            storedScope.startsWith(`${scope}:settlement:`)) &&
          stored.challenge.paymentHash === paymentHash
        ) {
          state?.challenges.delete(storedScope);
        }
      }
    },
  };
}
