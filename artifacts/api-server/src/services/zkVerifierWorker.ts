// One warmed worker, one active verification. Queued jobs stay on the main
// thread so a stuck proof can be terminated without discarding other callers.
import { Worker } from "node:worker_threads";
import { computeContext } from "../lib/compute-context";

const workerUrl = new URL("./zk/verifier-worker.mjs", import.meta.url);
type ProofInput = { verificationKey: unknown; publicSignals: string[]; proof: unknown };
type VerifierWorker = Pick<Worker, "on" | "postMessage" | "ref" | "unref" | "terminate">;
type Job = {
  input: ProofInput;
  identity: string;
  resolve(value: boolean): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort(): void;
};

export class ZkVerifierWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZkVerifierWorkerError";
  }
}
export class ZkVerifierBusyError extends ZkVerifierWorkerError {
  constructor() { super("zk verification capacity unavailable; retry later"); }
}

/** Exported for deterministic scheduler tests; production uses one singleton. */
export function createGroth16Verifier(options: {
  maxPending?: number;
  maxPerIdentity?: number;
  timeoutMs?: number;
  workerFactory?: () => VerifierWorker;
} = {}) {
  const maxPending = options.maxPending ?? 64;
  const maxPerIdentity = options.maxPerIdentity ?? 8;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (![maxPending, maxPerIdentity, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0))
    throw new RangeError("Verifier limits must be positive safe integers");
  const queues = new Map<string, Job[]>();
  const counts = new Map<string, number>();
  let pending = 0;
  let nextId = 0;
  let lastIdentity: string | undefined;
  let active: { job: Job; id: number } | undefined;
  let worker: VerifierWorker | undefined;
  let retiring: Promise<unknown> | undefined;
  let stopping = false;

  const finish = (job: Job, error?: Error, valid = false) => {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    pending--;
    const count = counts.get(job.identity)! - 1;
    if (count) counts.set(job.identity, count);
    else counts.delete(job.identity);
    if (error) job.reject(error);
    else job.resolve(valid);
  };
  const retire = () => {
    const old = worker;
    worker = undefined;
    if (!old) return;
    // Do not start a replacement until the old CPU worker has actually exited.
    retiring = Promise.resolve(old.terminate()).catch(() => undefined).finally(() => {
      retiring = undefined;
      pump();
    });
  };
  const failActive = (error: Error) => {
    const running = active;
    active = undefined;
    retire();
    if (running) finish(running.job, error);
    if (!retiring) queueMicrotask(pump);
  };
  const startWorker = () => {
    const thread = options.workerFactory?.() ?? new Worker(workerUrl, {
      workerData: { type: "module", mod: "data:text/javascript," },
    });
    worker = thread;
    thread.on("message", (reply: { id: number; valid?: boolean; error?: string }) => {
      if (worker !== thread || !active || reply.id !== active.id) return;
      const { job } = active;
      active = undefined;
      thread.unref();
      finish(job, typeof reply.error === "string" ? new ZkVerifierWorkerError("zk verification failed") : undefined,
        reply.valid === true);
      pump();
    });
    thread.on("error", () => {
      if (worker === thread) failActive(new ZkVerifierWorkerError("zk verifier worker failed"));
    });
    thread.on("exit", () => {
      if (worker === thread) failActive(new ZkVerifierWorkerError("zk verifier worker exited"));
    });
    thread.unref();
    return thread;
  };
  function pump() {
    if (active || retiring || stopping || !queues.size) return;
    // Rotate identity buckets, rather than allowing one swarm to monopolize FIFO.
    const firstIdentity = queues.keys().next().value!;
    if (queues.size > 1 && firstIdentity === lastIdentity) {
      const firstQueue = queues.get(firstIdentity)!;
      queues.delete(firstIdentity);
      queues.set(firstIdentity, firstQueue);
    }
    const [identity, queue] = queues.entries().next().value!;
    queues.delete(identity);
    const job = queue.shift()!;
    if (queue.length) queues.set(identity, queue);
    active = { job, id: ++nextId };
    lastIdentity = identity;
    try {
      const thread = worker ?? startWorker();
      thread.ref();
      thread.postMessage({ id: active.id, ...job.input });
    } catch {
      failActive(new ZkVerifierWorkerError("zk verifier worker could not accept proof"));
    }
  }
  return {
    verify(input: ProofInput, identity = "anonymous", signal?: AbortSignal): Promise<boolean> {
      if (stopping || signal?.aborted) return Promise.reject(new ZkVerifierWorkerError("zk verification aborted"));
      if (pending >= maxPending || (counts.get(identity) ?? 0) >= maxPerIdentity)
        return Promise.reject(new ZkVerifierBusyError());
      return new Promise<boolean>((resolve, reject) => {
        const cancel = (error: Error) => {
          if (active?.job === job) failActive(error);
          else {
            const queue = queues.get(identity);
            const index = queue?.indexOf(job) ?? -1;
            if (index < 0) return;
            queue!.splice(index, 1);
            if (!queue!.length) queues.delete(identity);
            finish(job, error);
          }
        };
        const job: Job = {
          input, identity, resolve, reject, signal,
          abort: () => cancel(new ZkVerifierWorkerError("zk verification aborted")),
          timer: setTimeout(() => cancel(new ZkVerifierWorkerError(`zk verification exceeded ${timeoutMs} ms`)), timeoutMs),
        };
        pending++;
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
        const queue = queues.get(identity) ?? [];
        queue.push(job);
        queues.set(identity, queue);
        signal?.addEventListener("abort", job.abort, { once: true });
        pump();
      });
    },
    async terminate() {
      stopping = true;
      if (active) failActive(new ZkVerifierWorkerError("zk verifier stopped"));
      else retire();
      for (const queue of queues.values())
        for (const job of queue) finish(job, new ZkVerifierWorkerError("zk verifier stopped"));
      queues.clear();
      await retiring;
      stopping = false;
    },
  };
}

const verifier = createGroth16Verifier();
export function verifyGroth16OffThread(verificationKey: unknown, publicSignals: string[], proof: unknown): Promise<boolean> {
  const context = computeContext();
  return verifier.verify({ verificationKey, publicSignals, proof }, context?.identity, context?.signal);
}
export const terminateZkVerifierWorker = () => verifier.terminate();
