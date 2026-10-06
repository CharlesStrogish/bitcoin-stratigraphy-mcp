import { canonicalJson, fromHex, toHex, utf8, type Json } from "./canonical.ts";
import { MerkleAccumulator, sha256, verifyMerkleInclusion } from "./merkle.ts";

export const LEAF_SCHEMA = "saai-swarm-leaf/1";
export const PROOF_SCHEMA = "saai-swarm-inclusion/1";
export const AGENT_COUNT = 50;
export const TRACE_COUNT = 1000;
export const BATCH_SIZE = 50;
export const NOTARIZE_BATCH_SIZE = "100";

export type Trace = { [k: string]: Json } & {
  agent_id: string; trace_id: string; round: number; role: string; tool: string; thought: string; tokens_in: number; tokens_out: number;
};
export type LeafRecord = { index: number; trace: Trace; salt: string };
export type InclusionProof = {
  schema_version: string; batch_id: string; leaf_index: number; tree_size: number; leaf_salt: string; path: string[];
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ROLES = ["planner", "retriever", "auditor", "executor", "reviewer"];
const TOOLS = ["ledger.query", "policy.lookup", "vector.search", "ticket.update", "calc.reconcile", "doc.summarize"];
const VERBS = ["Reconciled", "Flagged", "Escalated", "Deferred", "Cross-checked", "Summarized", "Rejected", "Approved"];
const OBJECTS = ["a vendor invoice batch", "a retention policy exception", "a procurement approval chain", "an access review queue",
  "a quarterly accrual schedule", "a contract renewal clause", "a data-residency attestation", "an incident postmortem draft"];
const REASONS = ["because the totals diverged by 0.7 percent", "after two sources disagreed on the owner",
  "since the approval predates the policy change", "pending a second reviewer signature",
  "because the audit window closes in 3 days", "given a missing change-ticket reference"];

export function makeTrace(i: number): Trace {
  const r = mulberry32(i * 7919 + 13);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const agent = i % AGENT_COUNT;
  return {
    agent_id: `agent-${String(agent).padStart(2, "0")}`,
    trace_id: `t-${String(i).padStart(4, "0")}`,
    round: Math.floor(i / AGENT_COUNT),
    role: ROLES[agent % ROLES.length],
    tool: pick(TOOLS),
    thought: `${pick(VERBS)} ${pick(OBJECTS)} ${pick(REASONS)}.`,
    tokens_in: 200 + Math.floor(r() * 1800),
    tokens_out: 40 + Math.floor(r() * 600),
  };
}

export function freshSalt(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}
export function leafPreimage(trace: Json, salt: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(salt)) throw new Error("Salt must be 32 canonical lowercase hex bytes");
  return utf8(canonicalJson({ schema_version: LEAF_SCHEMA, salt, trace }));
}

export class SwarmSession {
  readonly batchId: string;
  records: LeafRecord[] = [];
  private acc = new MerkleAccumulator();
  constructor(batchId = `sim-${toHex(globalThis.crypto.getRandomValues(new Uint8Array(6)))}`) { this.batchId = batchId; }
  get size() { return this.acc.size; }
  async append(trace: Trace, salt = freshSalt()): Promise<number> {
    const index = await this.acc.append(leafPreimage(trace, salt));
    this.records.push({ index, trace, salt });
    return index;
  }
  async rootHex(size: number = this.size) { return toHex(await this.acc.root(size)); }
  async peaks(size: number = this.size) { return (await this.acc.peaks(size)).map((p) => ({ ...p, hash: toHex(p.hash) })); }
  /** Atomic read of one immutable prefix: proof and root share the captured size. */
  async disclosure(index: number, size: number = this.size): Promise<{ proof: InclusionProof; rootHex: string }> {
    const rec = this.records[index];
    if (!rec || index >= size) throw new Error("No such leaf in this prefix");
    const [path, root] = await Promise.all([this.acc.inclusionPath(index, size), this.acc.root(size)]);
    return {
      proof: { schema_version: PROOF_SCHEMA, batch_id: this.batchId, leaf_index: index, tree_size: size, leaf_salt: rec.salt, path: path.map(toHex) },
      rootHex: toHex(root),
    };
  }
  async proof(index: number, size: number = this.size): Promise<InclusionProof> {
    return (await this.disclosure(index, size)).proof;
  }
}

/** Standalone verification from only the disclosed trace, proof and root. */
export async function verifyDisclosedProof(trace: Trace, proof: InclusionProof, rootHex: string): Promise<boolean> {
  if (proof.schema_version !== PROOF_SCHEMA) throw new Error("Unsupported proof schema");
  return verifyMerkleInclusion(leafPreimage(trace, proof.leaf_salt), proof.leaf_index, proof.tree_size,
    proof.path.map(fromHex), fromHex(rootHex));
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type BatchEvent = { batch: number; batches: number; size: number };
export async function runSwarm(opts: {
  session: SwarmSession; signal: AbortSignal; delayMs?: number; traceCount?: number;
  onBatch?: (e: BatchEvent) => void | Promise<void>;
}): Promise<void> {
  const { session, signal, delayMs = 260, traceCount = TRACE_COUNT } = opts;
  const batches = Math.ceil(traceCount / BATCH_SIZE);
  for (let b = 0; b < batches; b++) {
    await sleep(delayMs, signal);
    for (let i = b * BATCH_SIZE; i < Math.min(traceCount, (b + 1) * BATCH_SIZE); i++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      await session.append(makeTrace(i));
    }
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    await opts.onBatch?.({ batch: b + 1, batches, size: session.size });
  }
}

export async function simulateNotarize(batchId: string, treeSize: number, rootHex: string) {
  const digest = toHex(await sha256(utf8(`simulated-ots-illustration:${rootHex}`)));
  return {
    synthetic: true,
    event: "proof.notarize",
    request: {
      method: "POST",
      path: "/mcp tools/call proof.notarize (simulated, never sent)",
      headers: { "X-L402-Batch-Size": NOTARIZE_BATCH_SIZE },
      body: { batch_id: batchId, tree_size: treeSize, root_hash: rootHex },
    },
    payment: { simulated: true, invoice_paid: false, note: "No payment was requested or made." },
    receipt: {
      schema_version: "saai-swarm-root/1",
      batch_id: batchId,
      tree_size: treeSize,
      root_hash: rootHex,
      recorder_signature: null,
      anchoring: {
        status: "simulated_pending",
        settlement_unknown: false,
        calendar_submission: false,
        bitcoin_confirmation: false,
        otsProofHex: null,
        illustrative_ots_object: {
          kind: "illustrative-object-not-valid-ots-bytes",
          bound_root: rootHex,
          simulated_binding_digest: digest,
          attestation: "none; no calendar contacted, no Bitcoin block referenced",
        },
      },
    },
  };
}

export function buildProofExport(rec: LeafRecord, proof: InclusionProof, rootHex: string, anchor: Awaited<ReturnType<typeof simulateNotarize>> | null) {
  return {
    title: "Selective Disclosure proof (salted Merkle audit path, not zero-knowledge)",
    synthetic: true,
    disclosed_trace: rec.trace,
    merkle_proof: proof,
    root_hash: rootHex,
    simulated_anchor_receipt: anchor?.receipt ?? null,
    limitations:
      "Merkle paths are not zero-knowledge. Sibling hashes, tree size and leaf position are revealed. Other traces' plaintext and salts are excluded. The anchor receipt is simulated: no payment, no calendar submission, no Bitcoin confirmation.",
  };
}
