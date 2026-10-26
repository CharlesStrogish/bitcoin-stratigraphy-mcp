// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Request, Response } from "express";
import {
  createInvoicePow,
  INVOICE_POW_TTL_MS,
} from "../../src/lib/invoice-pow";

const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex");
type Proof = { challenge: string; nonce: string };
function attempt(
  gate: ReturnType<typeof createInvoicePow>,
  binding = "request-a",
  proof?: Proof,
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
    admitted: gate.admit(
      { get: (name: string) => headers.get(name) } as Request,
      res as unknown as Response,
      binding,
    ),
    ...result,
  };
}
function solve(challenge: string): Proof {
  let nonce = 0;
  while (!hash(`${challenge}:${nonce}`).startsWith("00")) nonce++;
  return { challenge, nonce: String(nonce) };
}

test("challenge issuance is unique; invalid, oversized, tampered and missing proofs fail closed", () => {
  const gate = createInvoicePow({ difficulty: 2 });
  const first = attempt(gate);
  const second = attempt(gate);
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
    assert.equal(attempt(gate, "request-a", invalid).status, 400);
  assert.equal(
    attempt(gate, "changed-price-tool-body-or-agent", proof).status,
    400,
  );
  assert.equal(attempt(gate, "request-a", proof).admitted, true);
  assert.equal(attempt(gate, "request-a", proof).status, 400, "one-time use");
  assert.equal(
    attempt(createInvoicePow({ difficulty: 2 }), "request-a", proof).status,
    400,
    "a different worker cannot replay a token",
  );
});

test("expired proofs, wrong hash nonce and bounded replay storage cannot reach invoice generation", () => {
  let now = Date.now();
  const gate = createInvoicePow({
    difficulty: 2,
    now: () => now,
    maxConsumed: 1,
  });
  const first = solve(attempt(gate).body.proof_of_work.challenge);
  let wrongNonce = 0;
  while (hash(`${first.challenge}:${wrongNonce}`).startsWith("00"))
    wrongNonce++;
  assert.equal(
    attempt(gate, "request-a", { ...first, nonce: String(wrongNonce) }).status,
    400,
  );
  assert.equal(attempt(gate, "request-a", first).admitted, true);
  const second = solve(attempt(gate).body.proof_of_work.challenge);
  assert.equal(attempt(gate, "request-a", second).status, 503);
  now += INVOICE_POW_TTL_MS;
  assert.equal(attempt(gate, "request-a", second).status, 400);
  const fresh = solve(attempt(gate).body.proof_of_work.challenge);
  assert.equal(
    attempt(gate, "request-a", fresh).admitted,
    true,
    "expired replay entries are reclaimed",
  );
});
