// RFC 6962-style ordered, unpadded Merkle tree. Mirrors cookbooks/swarm_merkle.py.
export const MAX_LEAVES = 1_000_000;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export const leafHash = (data: Uint8Array) =>
  sha256(concat(new Uint8Array([0]), data));
export function nodeHash(l: Uint8Array, r: Uint8Array) {
  if (l.length !== 32 || r.length !== 32)
    throw new Error("Child hashes must be 32 bytes");
  return sha256(concat(new Uint8Array([1]), l, r));
}
export function splitSize(size: number): number {
  if (!Number.isInteger(size) || size < 2 || size > MAX_LEAVES)
    throw new Error("Expected a bounded nonsingleton tree");
  return 1 << (31 - Math.clz32(size - 1));
}
function validatePosition(index: number, size: number) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_LEAVES)
    throw new Error("Invalid tree size");
  if (!Number.isInteger(index) || index < 0 || index >= size)
    throw new Error("Leaf index outside this tree");
}
const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export class MerkleAccumulator {
  size = 0;
  private nodes = new Map<string, Uint8Array>();
  async append(data: Uint8Array): Promise<number> {
    let digest = await leafHash(data);
    const index = this.size;
    let start = index;
    let width = 1;
    this.nodes.set(`${start},${width}`, digest);
    while (start % (2 * width)) {
      digest = await nodeHash(
        this.nodes.get(`${start - width},${width}`)!,
        digest,
      );
      start -= width;
      width *= 2;
      this.nodes.set(`${start},${width}`, digest);
    }
    this.size += 1;
    return index;
  }
  private async subtree(start: number, size: number): Promise<Uint8Array> {
    const cached = this.nodes.get(`${start},${size}`);
    if (cached) return cached;
    const w = splitSize(size);
    return nodeHash(
      await this.subtree(start, w),
      await this.subtree(start + w, size - w),
    );
  }
  private prefix(size: number): number {
    if (!Number.isInteger(size) || size < 0 || size > this.size)
      throw new Error("Prefix exceeds appended leaves");
    return size;
  }
  /** Root of the immutable prefix of `size` leaves (default: current size, captured synchronously). */
  async root(size: number = this.size): Promise<Uint8Array> {
    const n = this.prefix(size);
    return n ? this.subtree(0, n) : sha256(new Uint8Array());
  }
  /** Perfect subtrees (peaks) that fold into the root, left to right. */
  async peaks(
    size: number = this.size,
  ): Promise<{ start: number; width: number; hash: Uint8Array }[]> {
    const n = this.prefix(size);
    const out: { start: number; width: number; hash: Uint8Array }[] = [];
    let start = 0;
    for (let bit = 31 - Math.clz32(Math.max(n, 1)); bit >= 0 && n; bit--) {
      const width = 1 << bit;
      if (n & width) {
        out.push({ start, width, hash: await this.subtree(start, width) });
        start += width;
      }
    }
    return out;
  }
  async inclusionPath(
    index: number,
    size: number = this.size,
  ): Promise<Uint8Array[]> {
    const n = this.prefix(size);
    validatePosition(index, n);
    const walk = async (
      start: number,
      size: number,
      offset: number,
    ): Promise<Uint8Array[]> => {
      if (size === 1) return [];
      const w = splitSize(size);
      if (offset < w)
        return [
          ...(await walk(start, w, offset)),
          await this.subtree(start + w, size - w),
        ];
      return [
        ...(await walk(start + w, size - w, offset - w)),
        await this.subtree(start, w),
      ];
    };
    return walk(0, n, index);
  }
}

/** Returns false on digest mismatch; throws on malformed, short or extra paths. */
export async function verifyMerkleInclusion(
  data: Uint8Array,
  index: number,
  size: number,
  siblings: Uint8Array[],
  root: Uint8Array,
): Promise<boolean> {
  validatePosition(index, size);
  if (root.length !== 32) throw new Error("Root must be 32 bytes");
  if (siblings.length > 20 || siblings.some((s) => s.length !== 32))
    throw new Error("Invalid bounded sibling path");
  let used = 0;
  const digest = await leafHash(data);
  const rebuild = async (
    offset: number,
    width: number,
  ): Promise<Uint8Array> => {
    if (width === 1) return digest;
    const split = splitSize(width);
    const left = offset < split;
    const child = await rebuild(
      left ? offset : offset - split,
      left ? split : width - split,
    );
    if (used >= siblings.length) throw new Error("Audit path is too short");
    const sib = siblings[used++];
    return left ? nodeHash(child, sib) : nodeHash(sib, child);
  };
  const computed = await rebuild(index, size);
  if (used !== siblings.length)
    throw new Error("Audit path contains extra hashes");
  return eq(computed, root);
}
