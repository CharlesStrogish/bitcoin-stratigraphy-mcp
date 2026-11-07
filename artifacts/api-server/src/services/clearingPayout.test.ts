// ONLY clearing payout scaffolding. Synthetic invoices, keys and mocked LND.
// Never import/dispatch the 16 Fiduciary tools or payment.get_escrow.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { pool } from "@workspace/db";
import {
  clearingFeeLimit,
  LndPayoutAdapter,
  LndPayoutError,
  lndTransportFromEnvironment,
  type LndTransport,
} from "../adapters/lnd";
import {
  CLEARING_PAYOUT_DISABLED,
  executeFundedClearingPayout,
  requireClearingPayoutActivation,
  type ClearingPayoutLedger,
} from "./clearingPayout";
import { PostgresClearingPayoutLedger } from "./clearingPayoutLedger";
import { CLEARING_DDL, type ClearingContracts } from "./clearingContracts";
import type { SettlementRouter } from "./settlement";
import { clearingController } from "../routes/clearing";

const preimage = "ab".repeat(32);
const hash = createHash("sha256")
  .update(Buffer.from(preimage, "hex"))
  .digest("hex");
const invoice = "lnbc990000synthetictestonly";
const E = 100_000_000n,
  P = 99_000_000n,
  C = 1000n;
const errorCode = (code: string, outcome?: string) => (error: unknown) =>
  error instanceof LndPayoutError &&
  error.code === code &&
  (outcome === undefined || error.outcome === outcome);

function mockLnd(
  options: {
    estimate?: bigint;
    actual?: bigint;
    principal?: bigint;
    status?: string;
    timeout?: boolean;
    wrongHash?: boolean;
    invalidPreimage?: boolean;
    inFlight?: boolean;
    expiry?: string;
    malformedEstimate?: boolean;
  } = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const transport: LndTransport = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/v1/payreq/"))
      return {
        num_msat: (options.principal ?? P).toString(),
        payment_hash: hash,
        destination: "02" + "11".repeat(32),
        timestamp: Math.floor(Date.now() / 1000).toString(),
        expiry: options.expiry ?? "3600",
      };
    if (path === "/v2/router/route/estimatefee")
      return {
        routing_fee_msat: options.malformedEstimate
          ? "-1"
          : (options.estimate ?? 100n).toString(),
        failure_reason: "FAILURE_REASON_NONE",
      };
    assert.equal(path, "/v2/router/send");
    if (options.timeout) throw new Error("mock timeout");
    const result = {
      status: options.status ?? "SUCCEEDED",
      payment_hash: options.wrongHash ? "cd".repeat(32) : hash,
      payment_preimage: options.invalidPreimage ? "00".repeat(32) : preimage,
      value_msat: (options.principal ?? P).toString(),
      fee_msat: (options.actual ?? 777n).toString(),
    };
    return options.inFlight
      ? [{ result: { status: "IN_FLIGHT" } }, { result }]
      : { result };
  };
  return { adapter: new LndPayoutAdapter(transport), calls };
}

function memoryLedger(): ClearingPayoutLedger & {
  balance: bigint;
  reserved: boolean;
  failed: boolean;
  reservations: number;
} {
  return {
    balance: E,
    reserved: false,
    failed: false,
    reservations: 0,
    async reserve(_id, plan) {
      this.reservations++;
      if (this.reserved) return false;
      assert.ok(plan.principalMsat + plan.feeLimitSat * 1000n <= this.balance);
      this.reserved = true;
      return true;
    },
    async complete(_id, plan, fee) {
      assert.ok(this.reserved);
      assert.ok(fee <= plan.feeLimitSat * 1000n);
      this.balance -= plan.principalMsat + fee;
      this.reserved = false;
      return this.balance;
    },
    async fail() {
      this.reserved = false;
      this.failed = true;
    },
  };
}

test("integer proof: every admitted fee preserves escrow reserves, including rounding/headroom", () => {
  for (let sats = 1n; sats <= 10_000n; sats++) {
    const escrow = sats * 1000n + 999n;
    for (const principal of [
      1000n,
      sats * 1000n,
      (sats > 1n ? sats - 1n : 1n) * 1000n,
    ]) {
      const cap = clearingFeeLimit(escrow, principal);
      assert.ok(cap <= escrow / 100_000n);
      assert.ok(principal + cap * 1000n <= escrow);
      for (const fee of [0n, (cap * 1000n) / 2n, cap * 1000n])
        assert.ok(escrow - principal - fee >= 0n);
    }
  }
  assert.equal(clearingFeeLimit(E, P), C);
  assert.equal(clearingFeeLimit(E, E), 0n);
  for (const [escrow, principal] of [
    [0n, 1n],
    [E, E + 1n],
    [E, 1001n],
    [E, -1n],
  ])
    assert.throws(() => clearingFeeLimit(escrow!, principal!));
});

test("REST estimate one msat over cap is rejected BEFORE reservation or send", async () => {
  const { adapter, calls } = mockLnd({ estimate: C * 1000n + 1n });
  const ledger = memoryLedger();
  await assert.rejects(
    executeFundedClearingPayout("escrow", invoice, E, adapter, ledger),
    errorCode("CLEARING_ROUTING_FEE_CAP_EXCEEDED", "not-sent"),
  );
  assert.equal(calls.filter((c) => c.path === "/v2/router/send").length, 0);
  assert.equal(ledger.reservations, 0);
  assert.equal(ledger.balance, E);
});

test("exact cap is admitted; fee_limit_sat guards spikes after the estimate; fee debits only escrow", async () => {
  const { adapter, calls } = mockLnd({
    estimate: C * 1000n,
    actual: C * 1000n,
    inFlight: true,
  });
  const ledger = memoryLedger();
  const result = await executeFundedClearingPayout(
    "escrow",
    invoice,
    E,
    adapter,
    ledger,
  );
  assert.equal(result.escrow_balance_msat, "0");
  assert.equal(ledger.balance, 0n);
  assert.deepEqual(calls.at(-1)?.body, {
    payment_request: invoice,
    fee_limit_sat: "1000",
    timeout_seconds: 60,
    no_inflight_updates: true,
  });
  assert.equal(result.routing_fee_msat, "1000000");
});

test("actual sub-satoshi fee is debited exactly; unused fee reserve stays in escrow", async () => {
  const { adapter } = mockLnd();
  const ledger = memoryLedger();
  const result = await executeFundedClearingPayout(
    "escrow",
    invoice,
    E,
    adapter,
    ledger,
  );
  assert.equal(result.escrow_balance_msat, (E - P - 777n).toString());
  assert.equal(ledger.balance, E - P - 777n);
});

test("zero fee cap is explicit, never an omitted/unlimited LND fee parameter", async () => {
  const { adapter, calls } = mockLnd({
    principal: E,
    estimate: 0n,
    actual: 0n,
  });
  const ledger = memoryLedger();
  await executeFundedClearingPayout("escrow", invoice, E, adapter, ledger);
  assert.equal(
    (calls.at(-1)?.body as { fee_limit_sat: string }).fee_limit_sat,
    "0",
  );
});

test("route fee spike returns terminal failure without debiting escrow", async () => {
  const { adapter } = mockLnd({ status: "FAILED" });
  const ledger = memoryLedger();
  await assert.rejects(
    executeFundedClearingPayout("escrow", invoice, E, adapter, ledger),
    errorCode("LND_PAYMENT_FAILED", "failed"),
  );
  assert.equal(ledger.balance, E);
  assert.equal(ledger.reserved, false);
  assert.equal(ledger.failed, true);
});

test("unknown, unbound or over-cap results keep the full reservation and never resend", async () => {
  for (const options of [
    { timeout: true },
    { status: "IN_FLIGHT" },
    { wrongHash: true },
    { invalidPreimage: true },
    { actual: C * 1000n + 1n },
  ]) {
    const { adapter, calls } = mockLnd(options);
    const ledger = memoryLedger();
    await assert.rejects(
      executeFundedClearingPayout("escrow", invoice, E, adapter, ledger),
      errorCode("LND_PAYMENT_OUTCOME_UNKNOWN", "unknown"),
    );
    assert.equal(ledger.balance, E);
    assert.equal(ledger.reserved, true);
    assert.equal(ledger.failed, false);
    await assert.rejects(
      executeFundedClearingPayout("escrow", invoice, E, adapter, ledger),
      errorCode("CLEARING_PAYOUT_ALREADY_RESERVED"),
    );
    assert.equal(calls.filter((c) => c.path === "/v2/router/send").length, 1);
  }
});

test("database finalization failure after successful LND send stays reserved", async () => {
  const { adapter } = mockLnd();
  const ledger = memoryLedger();
  ledger.complete = async () => {
    throw new Error("mock database unavailable");
  };
  await assert.rejects(
    executeFundedClearingPayout("escrow", invoice, E, adapter, ledger),
  );
  assert.equal(ledger.reserved, true);
  assert.equal(ledger.failed, false);
});

test("forged/replayed plans, malformed estimates and expired invoices never send", async () => {
  const { adapter, calls } = mockLnd();
  const plan = await adapter.prepare(invoice, E);
  assert.equal(Object.isFrozen(plan), true);
  await assert.rejects(adapter.pay({ ...plan, invoice: "lnbcother" }));
  await assert.rejects(adapter.pay({ ...plan, feeLimitSat: C + 1n }));
  assert.equal(calls.filter((c) => c.path === "/v2/router/send").length, 0);
  await adapter.pay(plan);
  await assert.rejects(adapter.pay(plan));
  assert.equal(calls.filter((c) => c.path === "/v2/router/send").length, 1);
  await assert.rejects(
    mockLnd({ malformedEstimate: true }).adapter.prepare(invoice, E),
  );
  await assert.rejects(mockLnd({ expiry: "0" }).adapter.prepare(invoice, E));
  await assert.rejects(
    mockLnd({ principal: E + 1000n }).adapter.prepare(invoice, E),
  );
});

test("LND config is required and cannot disable HTTPS certificate validation", () => {
  for (const env of [
    {},
    { LND_REST_URL: "https://lnd.test.invalid" },
    { LND_REST_URL: "http://lnd.test.invalid", LND_MACAROON: "aa" },
    { LND_REST_URL: "https://user:pass@lnd.test.invalid", LND_MACAROON: "aa" },
    { LND_REST_URL: "https://lnd.test.invalid", LND_MACAROON: "not-hex" },
  ])
    assert.throws(() => lndTransportFromEnvironment(env));
  assert.equal(
    typeof lndTransportFromEnvironment({
      LND_REST_URL: "https://lnd.test.invalid",
      LND_MACAROON: "aa",
    }),
    "function",
  );
});

test("PostgreSQL reservation is exclusive; actual fee and principal debit only the clearing escrow", async () => {
  const client = await pool.connect();
  const schema = "clearing_payout_test_" + randomUUID().replaceAll("-", "");
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(CLEARING_DDL);
    const id = randomUUID();
    await client.query(
      `INSERT INTO clearing_contracts
       (escrow_id,request_digest,buyer_pubkey,worker_pubkey,task_hash,amount_sats)
       VALUES ($1,$2,$3,$3,$3,$4)`,
      [id, "11".repeat(32), "22".repeat(32), (E / 1000n).toString()],
    );
    const ledger = new PostgresClearingPayoutLedger(client);
    await ledger.initialize();
    const { adapter, calls } = mockLnd();
    const plan = await adapter.prepare(invoice, E);
    const reserved = await Promise.all([
      ledger.reserve(id, plan),
      ledger.reserve(id, plan),
    ]);
    assert.deepEqual(reserved, [true, false]);
    const before = (await client.query("SELECT * FROM clearing_payouts"))
      .rows[0]!;
    assert.equal(before.reserved_msat, (P + C * 1000n).toString());
    const paid = await adapter.pay(plan);
    assert.equal(await ledger.complete(id, plan, paid.feeMsat), E - P - 777n);
    const afterRow = (await client.query("SELECT * FROM clearing_payouts"))
      .rows[0]!;
    assert.equal(afterRow.escrow_balance_msat, (E - P - 777n).toString());
    assert.equal(afterRow.reserved_msat, "0");
    assert.equal(afterRow.fee_paid_msat, "777");
    assert.equal(afterRow.status, "settled");
    await assert.rejects(ledger.complete(id, plan, paid.feeMsat));
    assert.equal(await ledger.reserve(id, plan), false);
    assert.equal(calls.filter((c) => c.path === "/v2/router/send").length, 1);
  } finally {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
});

test("worker-signed payout settlement is unconditionally disabled, even in opted-in development", async () => {
  const old = {
    NODE_ENV: process.env.NODE_ENV,
    CLEARING_DEVELOPMENT_SETTLEMENT:
      process.env.CLEARING_DEVELOPMENT_SETTLEMENT,
    NIP98_PUBLIC_ORIGIN: process.env.NIP98_PUBLIC_ORIGIN,
  };
  const secret = generateSecretKey();
  const worker = getPublicKey(secret);
  const id = randomUUID();
  let downstreamCalls = 0;
  const store = {
    get: async () => ({
      escrow_id: id,
      worker_pubkey: worker,
      status: "pending",
    }),
  } as unknown as ClearingContracts;
  const router = {
    verifyPayment: async () => {
      downstreamCalls++;
      throw new Error("must not call");
    },
  } as unknown as SettlementRouter;
  const app = express();
  app.use(
    express.json({
      verify(req, _res, bytes) {
        (req as typeof req & { rawBody: Buffer }).rawBody = bytes;
      },
    }),
  );
  app.use(
    "/mcp",
    clearingController({ store, settlementRouter: router, coreTools: [] }),
  );
  let server: Server | undefined;
  try {
    process.env.NODE_ENV = "development";
    process.env.CLEARING_DEVELOPMENT_SETTLEMENT = "1";
    delete process.env.NIP98_PUBLIC_ORIGIN;
    assert.throws(
      requireClearingPayoutActivation,
      errorCode(CLEARING_PAYOUT_DISABLED),
    );
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "clearing.settle_contract",
        arguments: {
          escrow_id: id,
          execution_trace: "unavailable",
          payout_invoice: invoice,
        },
      },
    });
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", createHash("sha256").update(body).digest("hex")],
        ],
        content: "",
      },
      secret,
    );
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64"),
      },
    });
    assert.equal(response.status, 503);
    const result = (await response.json()) as {
      error: { message: string; data: { payout_executed: boolean } };
    };
    assert.equal(result.error.message, CLEARING_PAYOUT_DISABLED);
    assert.equal(result.error.data.payout_executed, false);
    assert.equal(downstreamCalls, 0);
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

after(async () => {
  await pool.end();
});
