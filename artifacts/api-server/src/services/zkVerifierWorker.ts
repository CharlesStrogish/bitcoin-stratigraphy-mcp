// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
// Main-thread client for the Groth16 verifier worker (zk/verifier-worker.mjs,
// copied beside the bundles at build time). One worker serves every zk
// verifier; it is started on first use, keeps the process alive only while a
// verification is pending, and is replaced after it exits or stops answering.
import { Worker } from "node:worker_threads";

const JOB_TIMEOUT_MS = 60_000;
const workerUrl = new URL("./zk/verifier-worker.mjs", import.meta.url);

type PendingJob = {
  resolve(valid: boolean): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type VerifierThread = { worker: Worker; jobs: Map<number, PendingJob> };

type WorkerReply = { id: number; valid?: boolean; error?: string };

let current: VerifierThread | undefined;
let nextJobId = 0;

export class ZkVerifierWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZkVerifierWorkerError";
  }
}

function startThread(): VerifierThread {
  const worker = new Worker(workerUrl, {
    // snarkjs loads the web-worker package, which treats every worker thread
    // as one of its own pool workers and imports workerData.mod at start-up.
    // An empty module satisfies it.
    workerData: { type: "module", mod: "data:text/javascript," },
  });
  const thread: VerifierThread = { worker, jobs: new Map() };
  const fail = (error: Error) => {
    if (current === thread) current = undefined;
    for (const job of thread.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    thread.jobs.clear();
  };
  worker.on("message", (reply: WorkerReply) => {
    const job = thread.jobs.get(reply.id);
    if (!job) return;
    thread.jobs.delete(reply.id);
    clearTimeout(job.timer);
    if (thread.jobs.size === 0) worker.unref();
    if (typeof reply.error === "string") {
      job.reject(new ZkVerifierWorkerError(reply.error));
    } else {
      job.resolve(reply.valid === true);
    }
  });
  worker.on("error", (error: unknown) =>
    fail(
      new ZkVerifierWorkerError(
        `zk verifier worker failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ),
  );
  worker.on("exit", (code) =>
    fail(new ZkVerifierWorkerError(`zk verifier worker exited (${code})`)),
  );
  worker.unref();
  return thread;
}

/** Verifies a Groth16 proof on the verifier worker thread. */
export function verifyGroth16OffThread(
  verificationKey: unknown,
  publicSignals: string[],
  proof: unknown,
): Promise<boolean> {
  current ??= startThread();
  const thread = current;
  nextJobId += 1;
  const id = nextJobId;
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A worker that stops answering is replaced; its exit rejects any
      // other verification it still held.
      thread.jobs.delete(id);
      reject(
        new ZkVerifierWorkerError(
          `zk verification exceeded ${JOB_TIMEOUT_MS} ms`,
        ),
      );
      if (current === thread) current = undefined;
      void thread.worker.terminate();
    }, JOB_TIMEOUT_MS);
    timer.unref();
    thread.jobs.set(id, { resolve, reject, timer });
    thread.worker.ref();
    thread.worker.postMessage({ id, verificationKey, publicSignals, proof });
  });
}

/** Stops the verifier worker; pending verifications are rejected. */
export async function terminateZkVerifierWorker(): Promise<void> {
  const thread = current;
  current = undefined;
  await thread?.worker.terminate();
}
