// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import express from "express";
import { pool } from "@workspace/db";
import { createInvoicePow } from "../../src/lib/invoice-pow";
import {
  createPostgresInvoicePowStore,
  startInvoicePowCleanup,
} from "../../src/lib/postgres-invoice-pow-store";
import { createL402Middleware } from "../../src/middleware/l402";
import type { SettlementRouter } from "../../src/services/settlement";

after(async () => {
  await pool.end();
});
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function solve(challenge: string) {
  let nonce = 0;
  while (!hash(`${challenge}:${nonce}`).startsWith("000")) nonce++;
  return {
    "X-L402-PoW-Challenge": challenge,
    "X-L402-PoW-Nonce": String(nonce),
  };
}

test("real PostgreSQL permits cross-worker invoices, reserves races once, and survives worker replacement", async () => {
  const preimage = "11".repeat(32);
  const paymentHash = hash(Buffer.from(preimage, "hex"));
  let invoices = 0;
  let lookups = 0;
  const router: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "distributed-test",
    circuitState: () => [],
    async createInvoice() {
      invoices++;
      return {
        invoice: "lnbc2500n1distributed",
        paymentHash,
        provider: "distributed-test",
      };
    },
    async verifyPayment(input) {
      lookups++;
      assert.equal(input.preimage, preimage);
      assert.equal(input.expectedAmountMsats, 250_000);
      assert.equal(input.expectedDescription, "distributed invoice test");
      return { settledAt: Date.now(), provider: "distributed-test" };
    },
  };
  const servers: ReturnType<express.Express["listen"]>[] = [];
  const worker = async () => {
    const app = express();
    app.use(express.json());
    const gate = createL402Middleware({
      amountSats: 250,
      description: "distributed invoice test",
      sessionSecret: "shared-distributed-test-secret",
      settlementRouter: router,
      scopePath: "/paid",
      invoicePow: createInvoicePow({ store: createPostgresInvoicePowStore() }),
    });
    app.post("/invoice/request", gate, (_req, res) =>
      res.status(200).json({ paid: true }),
    );
    app.post("/paid", gate, (_req, res) =>
      res.status(200).json({ paid: true }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const request = async (
    base: string,
    headers: Record<string, string> = {},
    path = "/invoice/request",
  ) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ request: "same-exact-invoice" }),
    });
    return { status: response.status, body: await response.json() };
  };
  const ids: string[] = [];
  try {
    const a = await worker();
    const b = await worker();
    const c = await worker();
    const issued = await request(a);
    assert.equal(issued.status, 400);
    assert.equal(issued.body.proof_of_work.difficulty, 3);
    const token = issued.body.proof_of_work.challenge;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString(),
    );
    assert.ok(
      payload.expires > Date.now() + 118_000 &&
        payload.expires <= Date.now() + 120_000,
    );
    const id = hash(token);
    ids.push(id);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM invoice_pow_consumptions WHERE challenge_id = $1",
          [id],
        )
      ).rows.length,
      0,
      "unverified challenges allocate no database rows",
    );
    const proof = solve(token);
    const raced = await Promise.all([request(b, proof), request(c, proof)]);
    assert.deepEqual(raced.map((result) => result.status).sort(), [400, 402]);
    assert.equal(invoices, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM invoice_pow_consumptions WHERE challenge_id = $1",
          [id],
        )
      ).rows.length,
      1,
    );
    const replacement = await worker();
    assert.equal((await request(replacement, proof)).status, 400);
    const challenge = raced.find((result) => result.status === 402)!.body;
    const paid = await request(
      replacement,
      { Authorization: `L402 ${challenge.macaroon}:${preimage}` },
      "/paid",
    );
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(
      lookups,
      1,
      "paid verification is unchanged and requires no compute",
    );
    const next = await request(replacement);
    const nextToken = next.body.proof_of_work.challenge;
    ids.push(hash(nextToken));
    assert.equal((await request(a, solve(nextToken))).status, 402);
    assert.equal(
      invoices,
      2,
      "another worker generates a fresh invoice successfully",
    );
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    await pool.query(
      "DELETE FROM invoice_pow_consumptions WHERE challenge_id = ANY($1::text[])",
      [ids],
    );
  }
});

test("PostgreSQL refuses expired reservations and the scheduled sweeper purges expired rows while idle", async () => {
  const store = createPostgresInvoicePowStore();
  const expired = hash(randomUUID());
  const live = hash(randomUUID());
  const periodic = hash(randomUUID());
  let sweeps = 0;
  const errors: unknown[] = [];
  const stop = startInvoicePowCleanup(
    {
      consume: store.consume,
      async purgeExpired() {
        await store.purgeExpired();
        sweeps++;
      },
    },
    20,
    (error) => {
      errors.push(error);
    },
  );
  const count = async (id: string) =>
    (
      await pool.query(
        "SELECT 1 FROM invoice_pow_consumptions WHERE challenge_id = $1",
        [id],
      )
    ).rows.length;
  const waitUntilGone = async (id: string) => {
    const deadline = Date.now() + 3_000;
    while (await count(id)) {
      assert.ok(Date.now() < deadline, "automatic expiry cleanup did not run");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    assert.equal(await store.consume(expired, Date.now() - 1_000), false);
    assert.equal(await store.consume(live, Date.now() + 120_000), true);
    await pool.query(
      "INSERT INTO invoice_pow_consumptions VALUES ($1, clock_timestamp() - interval '1 second')",
      [expired],
    );
    await waitUntilGone(expired);
    const before = sweeps;
    await pool.query(
      "INSERT INTO invoice_pow_consumptions VALUES ($1, clock_timestamp() - interval '1 second')",
      [periodic],
    );
    await waitUntilGone(periodic);
    assert.ok(sweeps > before, "periodic sweep ran without any HTTP requests");
    assert.equal(await count(live), 1, "live reservations survive cleanup");
    assert.deepEqual(errors, []);
    await stop();
    const stoppedCount = sweeps;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sweeps, stoppedCount, "shutdown stops the timer");
  } finally {
    await stop();
    await pool.query(
      "DELETE FROM invoice_pow_consumptions WHERE challenge_id = ANY($1::text[])",
      [[expired, live, periodic]],
    );
  }
});
