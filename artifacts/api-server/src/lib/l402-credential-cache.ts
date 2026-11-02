import { L402EdgeCache } from "./l402-edge-cache";
import {
  inspectSubscriptionMacaroon,
  type VerifiedSubscriptionMacaroon,
} from "./subscription-pass";

/**
 * Positive HMAC-chain/caveat parsing cache, NOT an authorization decision.
 * Callers must still check time, agent/tool binding, revocation and quota.
 */
export class L402CredentialCache {
  private readonly entries: L402EdgeCache<VerifiedSubscriptionMacaroon>;

  constructor(
    now: () => number = Date.now,
    capacity = 10_000,
    private readonly inspect: typeof inspectSubscriptionMacaroon = inspectSubscriptionMacaroon,
  ) {
    this.entries = new L402EdgeCache(now, capacity);
  }

  get size(): number { return this.entries.size; }

  inspectAuthenticity(encoded: string, secret: string): VerifiedSubscriptionMacaroon | null {
    // Exact credential bytes AND issuer secret: no parent/child, tampered-token
    // or key-rotation collisions. Raw tokens and secrets never become keys.
    const key = L402EdgeCache.key(secret, encoded);
    const cached = this.entries.get(key);
    if (cached) return structuredClone(cached);
    const pass = this.inspect(encoded, secret);
    if (pass) {
      this.entries.set(
        key,
        structuredClone(pass),
        pass.expiresAt ?? pass.validUntil * 1_000,
      );
    }
    // Inspection intentionally preserves expired-authentic diagnostics. It
    // never caches expired/invalid results or decides whether a request may run.
    return pass;
  }
}

// Share CPU verification across route instances. Custom test clocks stay
// isolated; default production routes share a single 10,000-entry cache.
const caches = new WeakMap<() => number, L402CredentialCache>();
export function l402CredentialCache(now: () => number = Date.now): L402CredentialCache {
  let cache = caches.get(now);
  if (!cache) {
    cache = new L402CredentialCache(now);
    caches.set(now, cache);
  }
  return cache;
}
