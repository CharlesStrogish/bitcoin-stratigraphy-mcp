import { createHash } from "node:crypto";

export type RevenueChannel = "NIP-90" | "L402";
export type RevenueRequestKind = "stratigraphy" | "zk-proof";

type RevenueLedgerBase = {
  id: string;
  timestamp: string;
  channel: RevenueChannel;
  requestKind: RevenueRequestKind;
  satsReceived: number;
  paymentHash: string;
  clientIdentifier: string;
};

export type RevenueLedgerEntry = RevenueLedgerBase & (
  | { preimage: string; coinosPaymentId?: never }
  | { preimage?: never; coinosPaymentId: string }
);

export type RevenueChannelBreakdown = Record<RevenueChannel, number>;

export type RevenueGoalProgress = {
  targetSats: number;
  currentSats: number;
  remainingSats: number;
  percentage: number;
};

export type SanitizedRevenueLedgerEntry = Pick<
  RevenueLedgerEntry,
  "id" | "timestamp" | "channel" | "requestKind" | "satsReceived"
> & {
  paymentReference: string;
};

export interface RevenueLedger {
  record(entry: RevenueLedgerEntry): Promise<boolean>;
  getDailyVolume(): Promise<number>;
  getTotalVolume(): Promise<number>;
  getChannelBreakdown(): Promise<RevenueChannelBreakdown>;
  getGoalProgress(targetSats?: number): Promise<RevenueGoalProgress>;
  getRecent(limit?: number): Promise<SanitizedRevenueLedgerEntry[]>;
}

export function validateLedgerEntry(
  entry: RevenueLedgerEntry,
  now = Date.now(),
): void {
  if (!entry.id || !Number.isFinite(Date.parse(entry.timestamp))) {
    throw new TypeError("Ledger entry id and timestamp are required");
  }
  if (entry.channel !== "NIP-90" && entry.channel !== "L402") {
    throw new TypeError("Unsupported revenue channel");
  }
  if (
    entry.requestKind !== "stratigraphy" &&
    entry.requestKind !== "zk-proof"
  ) {
    throw new TypeError("Unsupported revenue request kind");
  }
  if (!Number.isSafeInteger(entry.satsReceived) || entry.satsReceived <= 0) {
    throw new RangeError("satsReceived must be a positive integer");
  }
  if (!/^[0-9a-f]{64}$/i.test(entry.paymentHash)) {
    throw new TypeError("paymentHash must be a 32-byte hexadecimal digest");
  }
  if (entry.coinosPaymentId !== undefined) {
    if (entry.channel !== "L402" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.coinosPaymentId)) {
      throw new TypeError("Invalid CoinOS settlement reference");
    }
  } else {
    if (!entry.preimage || !/^[0-9a-f]{64}$/i.test(entry.preimage)) {
      throw new TypeError("preimage must be a 32-byte hexadecimal value");
    }
    const boundHash = createHash("sha256")
      .update(Buffer.from(entry.preimage, "hex"))
      .digest("hex");
    if (boundHash !== entry.paymentHash.toLowerCase()) {
      throw new TypeError("preimage does not match paymentHash");
    }
  }
  if (!entry.clientIdentifier) {
    throw new TypeError("clientIdentifier is required");
  }
  if (Date.parse(entry.timestamp) > now + 5 * 60 * 1_000) {
    throw new RangeError("Ledger timestamp is too far in the future");
  }
}

export function sanitizeLedgerEntry(
  entry: RevenueLedgerEntry,
): SanitizedRevenueLedgerEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    channel: entry.channel,
    requestKind: entry.requestKind,
    satsReceived: entry.satsReceived,
    paymentReference: paymentReference(entry.paymentHash),
  };
}

export function paymentReference(paymentHash: string): string {
  return createHash("sha256")
    .update(paymentHash.toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

export async function recordRevenueWithRetry(
  ledger: RevenueLedger,
  entry: RevenueLedgerEntry,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 100;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await ledger.record(entry);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

export function goalProgress(
  currentSats: number,
  targetSats = 500_000,
): RevenueGoalProgress {
  if (!Number.isSafeInteger(targetSats) || targetSats <= 0) {
    throw new RangeError("targetSats must be a positive integer");
  }
  return {
    targetSats,
    currentSats,
    remainingSats: Math.max(0, targetSats - currentSats),
    percentage: Number(((currentSats / targetSats) * 100).toFixed(4)),
  };
}

export function createMemoryRevenueLedger(
  options: { now?: () => number } = {},
): RevenueLedger {
  const now = options.now ?? Date.now;
  const entries = new Map<string, RevenueLedgerEntry>();
  return {
    async record(entry) {
      validateLedgerEntry(entry, now());
      const key = entry.paymentHash.toLowerCase();
      if (entries.has(key)) return false;
      entries.set(key, structuredClone(entry));
      return true;
    },
    async getDailyVolume() {
      const threshold = now() - 24 * 60 * 60 * 1_000;
      return [...entries.values()]
        .filter((entry) => {
          const timestamp = Date.parse(entry.timestamp);
          return timestamp >= threshold && timestamp <= now();
        })
        .reduce((sum, entry) => sum + entry.satsReceived, 0);
    },
    async getTotalVolume() {
      return [...entries.values()].reduce(
        (sum, entry) => sum + entry.satsReceived,
        0,
      );
    },
    async getChannelBreakdown() {
      const breakdown: RevenueChannelBreakdown = { "NIP-90": 0, L402: 0 };
      for (const entry of entries.values()) {
        breakdown[entry.channel] += entry.satsReceived;
      }
      return breakdown;
    },
    async getGoalProgress(targetSats = 500_000) {
      return goalProgress(await this.getDailyVolume(), targetSats);
    },
    async getRecent(limit = 100) {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      return [...entries.values()]
        .sort(
          (left, right) =>
            Date.parse(right.timestamp) - Date.parse(left.timestamp),
        )
        .slice(0, safeLimit)
        .map(sanitizeLedgerEntry);
    },
  };
}