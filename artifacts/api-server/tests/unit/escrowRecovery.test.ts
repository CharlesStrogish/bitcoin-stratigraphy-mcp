// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EscrowExecutor,
  EscrowWorkerResult,
} from "../../src/services/escrowBridge";
import {
  createEscrowRecovery,
  EscrowLedgerRecoveringError,
} from "../../src/services/escrowRecovery";

const ledger: Record<string, unknown> = {
  verified_toll_sats: 24,
  settled_contracts: 1,
  genesis_escrow_id: "ba4f25dd-7f16-420c-9264-a16f102fd5a6",
};

type Deferred = {
  promise: Promise<EscrowWorkerResult>;
  resolve(result: EscrowWorkerResult): void;
};

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  const promise = new Promise<EscrowWorkerResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("fails closed until recovery has been started", async () => {
  const recovery = createEscrowRecovery({
    execute: async () => ({ status: 200, body: ledger }),
  });
  assert.equal(recovery.status, "idle");
  await assert.rejects(recovery.whenReady(), EscrowLedgerRecoveringError);
});

test("waiters are released only when the in-flight recovery attempt succeeds", async () => {
  const attempt = deferred();
  const operations: string[] = [];
  const logs: string[] = [];
  const recovery = createEscrowRecovery({
    execute: (async (operation) => {
      operations.push(operation);
      return attempt.promise;
    }) as EscrowExecutor,
    logger: {
      info: (_details, message) => logs.push(message),
      error: (_details, message) => logs.push(message),
    },
  });
  const firstAttempt = recovery.start();
  assert.equal(recovery.start(), firstAttempt, "start() is idempotent");
  assert.equal(recovery.status, "recovering");
  let released = false;
  const waiter = recovery.whenReady().then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(released, false);
  attempt.resolve({ status: 200, body: ledger });
  await waiter;
  assert.equal(await firstAttempt, true);
  assert.equal(recovery.status, "ready");
  assert.deepEqual(operations, ["stats"]);
  assert.deepEqual(logs, ["Escrow ledger recovered"]);
  await recovery.whenReady();
});

test("a failed attempt rejects waiters immediately and retries in the background", async () => {
  const results: EscrowWorkerResult[] = [
    { status: 503, body: { error: "database unavailable" } },
    { status: 200, body: ledger },
  ];
  let calls = 0;
  const logs: Array<{ message: string; details: Record<string, unknown> }> = [];
  const recovery = createEscrowRecovery({
    execute: async () => results[Math.min(calls++, results.length - 1)]!,
    retryDelaysMs: [20],
    logger: {
      info: (details, message) => logs.push({ details, message }),
      error: (details, message) => logs.push({ details, message }),
    },
  });
  const pending = recovery.whenReady();
  await assert.rejects(pending, EscrowLedgerRecoveringError);
  assert.equal(await recovery.start(), false);
  assert.equal(recovery.status, "retrying");
  await assert.rejects(recovery.whenReady(), EscrowLedgerRecoveringError);
  await until(() => recovery.status === "ready", "the retry");
  await recovery.whenReady();
  assert.equal(calls, 2);
  assert.deepEqual(
    logs.map(({ message }) => message),
    [
      "Escrow ledger recovery failed; escrow routes return 503 until a retry succeeds",
      "Escrow ledger recovered",
    ],
  );
  assert.equal(logs[0]!.details.retryInMs, 20);
  assert.equal(logs[1]!.details.attempts, 2);
});

test("an executor exception is a failed attempt, not an unhandled rejection", async () => {
  let calls = 0;
  const recovery = createEscrowRecovery({
    execute: async () => {
      calls += 1;
      throw new Error("worker crashed");
    },
    retryDelaysMs: [10],
  });
  assert.equal(await recovery.start(), false);
  await until(() => calls >= 2, "the retry");
  recovery.stop();
  const stoppedAt = calls;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(calls <= stoppedAt + 1, "stop() cancels further retries");
  assert.equal(recovery.status, "stopped");
  await assert.rejects(recovery.whenReady(), EscrowLedgerRecoveringError);
});

test("bounds how long a request waits for an attempt in progress", async () => {
  const attempt = deferred();
  const recovery = createEscrowRecovery({
    execute: (async () => attempt.promise) as EscrowExecutor,
    maxWaitMs: 20,
  });
  void recovery.start();
  const startedAt = Date.now();
  await assert.rejects(recovery.whenReady(), EscrowLedgerRecoveringError);
  assert.ok(Date.now() - startedAt < 2_000);
  attempt.resolve({ status: 200, body: ledger });
  await until(() => recovery.status === "ready", "the attempt");
  await recovery.whenReady();
});
