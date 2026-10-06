import { createHash } from "node:crypto";

/** Bounded TTL/LRU cache. Keys are fingerprints, never raw bearer credentials. */
export class L402EdgeCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly now = Date.now,
    private readonly capacity = 10_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Cache capacity must be positive");
  }

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
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, expires: number): void {
    if (expires <= this.now()) return;
    this.entries.delete(key);
    while (this.entries.size >= this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, expires });
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
