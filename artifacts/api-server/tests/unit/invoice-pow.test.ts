// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Request, Response } from "express";
import type { InvoicePowStore } from "../../src/lib/postgres-invoice-pow-store";
import {
  createInvoicePow,
  INVOICE_POW_TTL_MS,
} from "../../src/lib/invoice-pow";

const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex");
type Proof = { challenge: string; nonce: string };
async function attempt(
  gate: ReturnType<typeof createInvoicePow>,
  binding = "request-a",
  proof?: Proof,
  secret = "shared-invoice-test-secret",
) {
  const headers = new Map(
    Object.entries({
      "X-L402-PoW-Challenge": proof?.challenge,
      "X-L402-PoW-Nonce": proof?.nonce,
    }),
  );
  const result = { status: 0, body: {} as any };
  const res = {
    set() {
      return res;
    },
    status(status: number) {
      result.status = status;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      return res;
    },
  };
  return {
    admitted: await gate.admit(
      { get: (name: string) => headers.get(name) } as Request,
      res as unknown as Response,
      binding,
      secret,
    ),
    ...result,
  };
}
function solve(challenge: string): Proof {
  let nonce = 0;
  while (!hash(`${challenge}:${nonce}`).startsWith("00")) nonce++;
  return { challenge, nonce: String(nonce) };
}

function memoryStore(now = Date.now): InvoicePowStore {
  const consumed = new Map<string, number>();
  return {
    async consume(id, expires) {
      if (expires <= now() || consumed.has(id)) return false;
      consumed.set(id, expires);
      return true;
    },
    async purgeExpired() {
      for (const [id, expires] of consumed)
        if (expires <= now()) consumed.delete(id);
    },
  };
}

test("challenge issuance is unique; invalid, oversized, tampered and missing proofs fail closed", async () => {
  const store = memoryStore();
  const gate = createInvoicePow({ difficulty: 2, store });
  const first = await attempt(gate);
  const second = await attempt(gate);
  assert.equal(first.status, 400);
  assert.notEqual(
    first.body.proof_of_work.challenge,
    second.body.proof_of_work.challenge,
  );
  const proof = solve(first.body.proof_of_work.challenge);
  for (const invalid of [
    { ...proof, nonce: "-1" },
    { ...proof, nonce: "x" },
    { ...proof, nonce: "9".repeat(21) },
    { ...proof, challenge: proof.challenge + "x" },
    { ...proof, challenge: "x".repeat(1025) },
  ])
    assert.equal((await attempt(gate, "request-a", invalid)).status, 400);
  assert.equal(
    (await attempt(gate, "changed-price-tool-body-or-agent", proof)).status,
    400,
  );
  assert.equal(
    (await attempt(gate, "request-a", proof, "wrong-shared-secret")).status,
    400,
  );
  assert.equal(
    (
      await attempt(
        createInvoicePow({
          difficulty: 2,
          now: () => Date.now() - 1_000,
          store,
        }),
        "request-a",
        proof,
      )
    ).admitted,
    true,
    "a different worker authenticates and reserves the same challenge",
  );
  assert.equal(
    (await attempt(gate, "request-a", proof)).status,
    400,
    "global one-time use",
  );
});

test("expired proofs, wrong hash nonce and database failure cannot reach invoice generation", async () => {
  let now = Date.now();
  const gate = createInvoicePow({
    difficulty: 2,
    now: () => now,
    store: memoryStore(() => now),
  });
  const first = solve((await attempt(gate)).body.proof_of_work.challenge);
  let wrongNonce = 0;
  while (hash(`${first.challenge}:${wrongNonce}`).startsWith("00"))
    wrongNonce++;
  assert.equal(
    (await attempt(gate, "request-a", { ...first, nonce: String(wrongNonce) }))
      .status,
    400,
  );
  assert.equal((await attempt(gate, "request-a", first)).admitted, true);
  const second = solve((await attempt(gate)).body.proof_of_work.challenge);
  const failingWorker = createInvoicePow({
    difficulty: 2,
    now: () => now,
    store: {
      consume: async () => {
        throw new Error("database offline");
      },
      purgeExpired: async () => {},
    },
  });
  assert.equal((await attempt(failingWorker, "request-a", second)).status, 503);
  now += INVOICE_POW_TTL_MS;
  assert.equal((await attempt(gate, "request-a", second)).status, 400);
  const fresh = solve((await attempt(gate)).body.proof_of_work.challenge);
  assert.equal(
    (await attempt(gate, "request-a", fresh)).admitted,
    true,
    "new proofs remain usable after earlier challenges expire",
  );
});
