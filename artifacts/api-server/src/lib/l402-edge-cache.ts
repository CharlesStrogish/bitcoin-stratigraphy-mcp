import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";

/** Bounded TTL/LRU cache. Keys are fingerprints, never raw bearer credentials. */
export class L402EdgeCache<T> {
  private readonly entries: LRUCache<string, { value: T; expires: number }>;
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly now = Date.now,
    private readonly capacity = 10_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Cache capacity must be positive");
    this.entries = new LRUCache({
      max: capacity,
      // Accounted byte budgets complement the entry bound. Oversize values
      // are verified normally but not retained. These are not a process-RSS cap.
      maxSize: 32 * 1024 * 1024,
      maxEntrySize: 256 * 1024,
      sizeCalculation: (entry, key) =>
        Buffer.byteLength(key) +
        Buffer.byteLength(JSON.stringify(entry.value) ?? "") + 512,
      allowStale: false,
      updateAgeOnGet: false,
      ttlResolution: 0,
    });
  }

  get size(): number { return this.entries.size; }
  get calculatedSize(): number { return this.entries.calculatedSize; }

  static key(...parts: string[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, expires: number): void {
    const ttl = expires - this.now();
    if (!Number.isFinite(ttl) || ttl <= 0) {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, { value, expires }, { ttl });
  }

  async resolve(
    key: string,
    expires: number,
    load: () => Promise<T>,
    cacheable: (value: T) => boolean,
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const running = this.pending.get(key);
    if (running) return running;
    if (this.pending.size >= this.capacity)
      throw new Error("L402 verification capacity exceeded");
    const operation = Promise.resolve().then(load);
    this.pending.set(key, operation);
    try {
      const value = await operation;
      if (cacheable(value)) this.set(key, value, expires);
      return value;
    } finally {
      this.pending.delete(key);
    }
  }
}
