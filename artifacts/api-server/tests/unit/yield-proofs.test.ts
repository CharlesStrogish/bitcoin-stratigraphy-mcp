import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createPublicYieldLedger } from "../../src/lib/public-yield-ledger";
import { registerYieldProofRoutes } from "../../src/routes/yield-proofs";

const epoch = Date.parse("2026-10-30T12:00:00.000Z");
const confirmed = () => ({
  timestamp: new Date(epoch).toISOString(),
  toolExecuted: "stratigraphy.get",
  grossInvoiceMsats: 250_000n,
  yieldPaidMsats: 52_500n,
  confirmedPayout: true as const,
});

test("yield scaffold is empty, projects only public fields and binds exact 21% arithmetic", () => {
  const ledger = createPublicYieldLedger(() => epoch);
  assert.deepEqual(ledger.snapshot(), []);
  const record = ledger.appendConfirmedPayout({
    ...confirmed(),
    // An untrusted caller cannot make these fields public through object spreading.
    ...{ macaroon: "private-token", preimage: "private-preimage", address: "private-address" },
  });
  assert.equal(record.sats_yield_paid, 52.5);
  assert.deepEqual(Object.keys(record), [
    "timestamp", "tool_executed", "sats_yield_paid", "cryptographic_receipt",
  ]);
  assert.doesNotMatch(JSON.stringify(record), /private-token|private-preimage|private-address/);
  assert.equal(
    record.cryptographic_receipt.digest,
    createHash("sha256").update(JSON.stringify([
      record.timestamp, record.tool_executed, "250000", "52500", 21,
    ])).digest("hex"),
  );
  assert.equal(
    BigInt(record.cryptographic_receipt.yield_paid_msats),
    (BigInt(record.cryptographic_receipt.gross_invoice_msats) * 21n) / 100n,
  );
  ledger.appendConfirmedPayout(confirmed());
  assert.equal(ledger.snapshot().length, 1);
  record.cryptographic_receipt.digest = "tampered";
  const detached = ledger.snapshot();
  detached[0]!.cryptographic_receipt.digest = "also-tampered";
  assert.notEqual(ledger.snapshot()[0]!.cryptographic_receipt.digest, "also-tampered");
  assert.notEqual(ledger.snapshot()[0]!.cryptographic_receipt.digest, "tampered");
});

test("yield scaffold rejects allocations, invalid amounts, unsupported/free tools and invalid dates", () => {
  const ledger = createPublicYieldLedger(() => epoch);
  for (const patch of [
    { confirmedPayout: false }, { yieldPaidMsats: 0n }, { yieldPaidMsats: 52_499n },
    { grossInvoiceMsats: -1n }, { grossInvoiceMsats: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    { toolExecuted: "unregistered.tool" }, { toolExecuted: "stratigraphy.list" },
    { timestamp: "not-a-date" }, { timestamp: new Date(epoch + 1).toISOString() },
    { timestamp: new Date(epoch - 86_400_001).toISOString() },
  ]) {
    assert.throws(() => ledger.appendConfirmedPayout({
      ...confirmed(), ...patch,
    } as Parameters<typeof ledger.appendConfirmedPayout>[0]));
  }
  assert.deepEqual(ledger.snapshot(), []);
  ledger.appendConfirmedPayout({
    ...confirmed(), grossInvoiceMsats: 1_001n, yieldPaidMsats: 210n,
  });
  assert.equal(ledger.snapshot()[0]!.sats_yield_paid, 0.21);
});

test("yield scaffold is bounded, newest-first and expires without timers", () => {
  let now = epoch;
  const ledger = createPublicYieldLedger(() => now);
  for (let index = 0; index < 300; index++) {
    now = epoch + index;
    ledger.appendConfirmedPayout({ ...confirmed(), timestamp: new Date(now).toISOString() });
  }
  assert.equal(ledger.snapshot().length, 256);
  assert.equal(ledger.snapshot()[0]!.timestamp, new Date(now).toISOString());
  assert.equal(ledger.snapshot()[255]!.timestamp, new Date(epoch + 44).toISOString());
  now += 86_400_001;
  assert.deepEqual(ledger.snapshot(), []);
});

test("yield route is public before auth, aliases correctly, stays read-only and defaults to no fabricated history", async () => {
  const ledger = createPublicYieldLedger(() => epoch);
  const app = express();
  registerYieldProofRoutes(app, ledger);
  app.use((_req, res) => { res.status(401).end(); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/yield-proofs.json", "/api/yield-proofs.json"]) {
      const url = base + path;
      const response = await fetch(url, {
        headers: { Authorization: "L402 invalid:invalid", Origin: "https://agent.example" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("x-yield-proof-semantics") ?? "", /not independent/);
      const head = await fetch(url, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal((await fetch(url, { method: "OPTIONS" })).status, 204);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const denied = await fetch(url, {
          method, headers: { "Content-Type": "application/json" }, body: "{invalid-json",
        });
        assert.equal(denied.status, 405);
      }
    }
    ledger.appendConfirmedPayout(confirmed());
    const populated = await fetch(base + "/yield-proofs.json");
    assert.deepEqual(await populated.json(), ledger.snapshot());
    assert.equal((await fetch(base + "/private")).status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
