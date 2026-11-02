import { randomUUID } from "node:crypto";
import { finalizeEvent, SimplePool } from "nostr-tools";
import { logger } from "../lib/logger";
import { parsePrivateKey } from "./nostrAttestation";

export const YIELD_ORACLE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
] as const;

export type YieldBroadcast = (amountMsats: bigint) => void | Promise<void>;
type RelayPool = Pick<SimplePool, "publish" | "destroy">;

/** Exact satoshi text, including earned sub-satoshi balances; never round. */
function satoshiText(msats: bigint): string {
  const fraction = (msats % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${msats / 1000n}${fraction ? "." + fraction : ""}`;
}

export function createYieldOracle(options: {
  privateKey?: () => string | undefined;
  poolFactory?: () => RelayPool;
  timeoutMs?: number;
  now?: () => number;
  warn?: (event: string) => void;
} = {}): YieldBroadcast {
  let inFlight = 0;
  function warn(event: string) {
    try {
      if (options.warn) options.warn(event);
      else logger.warn({ event }, "Best-effort Nostr yield broadcast skipped or failed");
    } catch { /* Logging must not affect the withdrawal or background task. */ }
  }
  return async amountMsats => {
    let relayPool: RelayPool | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A test must explicitly inject its relay transport, even with real CI keys.
    if (process.env.NODE_ENV === "test" && !options.poolFactory) return;
    if (inFlight >= 16) { warn("yield_oracle_capacity"); return; }
    inFlight++;
    try {
      const privateKey = (options.privateKey ?? (() => process.env.NOSTR_SERVER_PRIVKEY))();
      if (!privateKey) { warn("yield_oracle_key_missing"); return; }
      if (amountMsats <= 0n) { warn("yield_oracle_invalid_amount"); return; }
      const event = finalizeEvent({
        kind: 1,
        created_at: Math.floor((options.now ?? Date.now)() / 1000),
        // Independent public randomness avoids collapsing equal-value withdrawals
        // within one second into the same event, without exposing a private ID.
        tags: [["t", "proof-of-yield"], ["event", randomUUID()]],
        content: `An autonomous agent just settled a ${satoshiText(amountMsats)} satoshi yield withdrawal from the BitcoinStratigraphy.com L402 Data Engine. 100% Mainnet execution.`,
      }, parsePrivateKey(privateKey));
      relayPool = options.poolFactory?.() ?? new SimplePool({ enableReconnect: false });
      const timeoutMs = options.timeoutMs ?? 5_000;
      const results = await Promise.race([
        Promise.allSettled(relayPool.publish([...YIELD_ORACLE_RELAYS], event, { maxWait: timeoutMs })),
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
      if (!results) warn("yield_oracle_relay_timeout");
      else if (!results.some(result => result.status === "fulfilled")) warn("yield_oracle_relays_rejected");
    } catch {
      // Do not log exceptions: a provider error can contain credentials or data.
      warn("yield_oracle_broadcast_failed");
    } finally {
      clearTimeout(timer);
      try { relayPool?.destroy(); } catch { /* Cleanup is best effort too. */ }
      inFlight--;
    }
  };
}

const defaultBroadcast = createYieldOracle();

/** Called after res.json and durable settlement; no signing or relay I/O inline. */
export function scheduleYieldBroadcast(amountMsats: bigint, broadcast: YieldBroadcast = defaultBroadcast): void {
  try {
    setImmediate(() => {
      void Promise.resolve().then(() => broadcast(amountMsats)).catch(() => {
        try { logger.warn({ event: "yield_oracle_background_failed" }, "Nostr yield broadcast failed"); }
        catch { /* Never surface a background logging error. */ }
      });
    });
  } catch { /* A scheduler failure cannot change a completed withdrawal. */ }
}
