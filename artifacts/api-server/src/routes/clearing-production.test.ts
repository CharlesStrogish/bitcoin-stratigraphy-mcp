// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
// Real Genesis proofs, NIP-98 and isolated PostgreSQL. Synthetic invoices ONLY.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import type { Server } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { poseidon2 } from "poseidon-lite";
import { groth16 } from "snarkjs";
import { pool } from "@workspace/db";
import { ClearingContracts } from "../services/clearingContracts";
import type { SettlementRouter } from "../services/settlement";
import {
  activeClearingKeys, developmentClearingKeys, isProductionClearing,
  loadProductionClearingKeys, GENESIS_VERIFICATION_KEY_ID,
} from "../services/clearingKeys";
import { terminateZkVerifierWorker } from "../services/zkVerifierWorker";
import { clearingController } from "./clearing";

type Reply = {
  result: { structuredContent: {
    escrow_id: string; settlement_available: boolean; execution_scheme: string;
    verification_key_id: string; payout_available: boolean; development_only: boolean;
    payout_executed: boolean;
    receipt: { payload: string; signature: string; key_id: string };
  } };
};

test("Genesis production settlement: real proofs and synthetic funding", async (t) => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(!process.env.REPLIT_DEPLOYMENT);
  const identity = generateKeyPairSync("ed25519");
  process.env.STRATIGRAPHY_PAYLOAD_PRIVATE_KEY = identity.privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
  const buyer = generateSecretKey(), worker = generateSecretKey();
  const task = poseidon2([1n, 2n]);
  const taskHash = task.toString(16).padStart(64, "0");
  const client = await pool.connect();
  const schema = "clearing_genesis_" + randomUUID().replaceAll("-", "");
  let server: Server | undefined;
  let lookups = 0, invoices = 0;
  let funding: "paid" | "invalid" | "unavailable" | "wrong-provider" = "paid";
  let beforeLookup: (() => Promise<void>) | undefined;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", pg_catalog`);
    const store = new ClearingContracts(client);
    const router: SettlementRouter = {
      isConfigured: () => true, activeProvider: () => "genesis-test",
      circuitState: () => "closed",
      createInvoice: async () => {
        invoices++;
        return { invoice: "lnbc-synthetic-not-payable", provider: "genesis-test",
          paymentHash: createHash("sha256").update(randomUUID()).digest("hex") };
      },
      verifyPayment: async (input) => {
        lookups++;
        assert.equal(input.preimage, "");
        assert.equal(input.verificationMode, "merchant-lookup");
        assert.equal(input.expectedProvider, "genesis-test");
        assert.equal(input.expectedAmountMsats, 100_000);
        assert.equal(input.asset, "btc-lightning");
        const row = (await client.query(
          "SELECT * FROM clearing_contracts WHERE payment_hash=$1", [input.paymentHash],
        )).rows[0];
        assert.ok(row);
        assert.equal(input.expectedDescription, `A2A clearing ${row.escrow_id} task ${row.task_hash}`);
        await beforeLookup?.();
        if (funding === "invalid" || funding === "unavailable") return funding;
        return { provider: funding === "wrong-provider" ? "other" : "genesis-test",
          asset: "btc-lightning", settledAt: Math.floor(Date.now() / 1000) };
      },
    };
    const app = express();
    app.use(express.json({ verify(req, _res, bytes) {
      (req as express.Request & { rawBody: Buffer }).rawBody = Buffer.from(bytes);
    } }));
    app.use("/mcp", clearingController({ store, settlementRouter: router,
      secret: "genesis-test-only", coreTools: [] }));
    server = await new Promise<Server>((ok) => {
      const s = app.listen(0, "127.0.0.1", () => ok(s));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    // Production mode applies ONLY inside this synthetic server/test process.
    process.env.NODE_ENV = "production";
    const keys = loadProductionClearingKeys();
    assert.equal(keys.verificationKeyId, GENESIS_VERIFICATION_KEY_ID);
    assert.notEqual(keys.verificationKeyId, developmentClearingKeys.verificationKeyId);
    assert.equal(keys.developmentOnly, false);
    assert.equal(activeClearingKeys(), keys);
    assert.equal(isProductionClearing({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" }), true);
    assert.equal(activeClearingKeys({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" }), keys);

    async function post(name: string, args: object, signer = worker, signedPayload?: string) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(),
        method: "tools/call", params: { name, arguments: args } });
      const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000),
        tags: [["u", url], ["method", "POST"],
          ["payload", createHash("sha256").update(signedPayload ?? body).digest("hex")]],
        content: "" }, signer);
      const res = await fetch(url, { method: "POST", body, headers: {
        "Content-Type": "application/json",
        "X-Nostr-Authorization": "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64"),
      } });
      return { status: res.status, body: await res.json() as Reply };
    }
    async function create() {
      const res = await post("clearing.create_contract",
        { worker_pubkey: getPublicKey(worker), task_hash: taskHash, amount_sats: 100 }, buyer);
      assert.equal(res.status, 200);
      const data = res.body.result.structuredContent;
      assert.equal(data.settlement_available, true);
      assert.equal(data.execution_scheme, keys.scheme);
      assert.equal(data.verification_key_id, keys.verificationKeyId);
      assert.equal(data.payout_available, false);
      return data.escrow_id as string;
    }
    async function trace(id: string, development = false) {
      const result = await groth16.fullProve({
        execution_trace_preimage: ["1", "2"], task_hash: task.toString(),
        escrow_binding: BigInt("0x" + id.replaceAll("-", "")).toString(),
      } as unknown as Record<string, string>,
      resolve("generated-artifacts/clearing-mpc/clearing_execution.wasm"),
      resolve(development ? "generated-artifacts/clearing-development/clearing_execution.zkey"
        : "artifacts/api-server/src/services/zk/clearing-production/circuit_final.zkey"),
      undefined, undefined, { singleThread: true });
      return { scheme: development ? developmentClearingKeys.scheme : keys.scheme, ...result };
    }
    const id = await create();
    const proof = await trace(id);
    const args = { escrow_id: id, execution_trace: JSON.stringify(proof) };

    await t.test("unauthorized worker and altered NIP-98 payload cannot reach funding", async () => {
      assert.equal((await post("clearing.settle_contract", args, buyer)).status, 403);
      assert.equal((await post("clearing.settle_contract", args, worker, "{}")).status, 401);
      assert.equal(lookups, 0);
    });
    await t.test("development key, relabeled old proof and altered signals fail before funding", async () => {
      const oldProof = await trace(id, true);
      const changed = [
        oldProof, { ...oldProof, scheme: keys.scheme },
        { ...proof, publicSignals: [task.toString(), "123"] },
        { ...proof, publicSignals: [(task + 1n).toString(), proof.publicSignals[1]] },
      ];
      for (const candidate of changed)
        assert.equal((await post("clearing.settle_contract", {
          ...args, execution_trace: JSON.stringify(candidate),
        })).status, 400);
      assert.equal(lookups, 0);
      assert.equal((await store.get(id))?.status, "pending");
    });
    await t.test("unpaid, unavailable and wrong-provider funding never settle", async () => {
      for (const mode of ["invalid", "unavailable", "wrong-provider"] as const) {
        funding = mode;
        assert.equal((await post("clearing.settle_contract", args)).status,
          mode === "unavailable" ? 503 : 409);
        assert.equal((await store.get(id))?.status, "pending");
      }
      funding = "paid";
    });
    await t.test("concurrent identical settlement commits once with a Genesis-signed receipt", async () => {
      const results = await Promise.all([
        post("clearing.settle_contract", args), post("clearing.settle_contract", args),
      ]);
      for (const result of results) assert.equal(result.status, 200);
      const data = results[0].body.result.structuredContent;
      assert.deepEqual(results[1].body.result.structuredContent, data);
      assert.equal(data.development_only, false);
      assert.equal(data.payout_executed, false);
      const claims = JSON.parse(data.receipt.payload);
      assert.equal(claims.schema, keys.scheme);
      assert.equal(claims.verification_key_id, keys.verificationKeyId);
      assert.equal(claims.development_only, false);
      assert.equal(claims.legal_indemnity_granted, false);
      assert.equal(claims.payout_executed, false);
      assert.equal(claims.funding_verified, true);
      assert.equal(claims.escrow_id, id);
      assert.equal(verify(null, Buffer.from(keys.receiptDomain + data.receipt.payload),
        identity.publicKey, Buffer.from(data.receipt.signature, "base64")), true);
      const before = lookups, beforeInvoices = invoices;
      const replay = await post("clearing.settle_contract", args);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body.result.structuredContent, data);
      assert.equal(lookups, before);
      assert.equal(invoices, beforeInvoices);
      assert.equal((await store.get(id))?.status, "settled");
      const alternate = await trace(id);
      assert.equal((await post("clearing.settle_contract", {
        ...args, execution_trace: JSON.stringify(alternate),
      })).status, 409);
    });
    await t.test("a contract mutation during funding lookup cannot commit", async () => {
      const changedId = await create(), changedProof = await trace(changedId);
      beforeLookup = async () => {
        await client.query("UPDATE clearing_contracts SET amount_sats=101 WHERE escrow_id=$1", [changedId]);
      };
      try {
        assert.equal((await post("clearing.settle_contract", {
          escrow_id: changedId, execution_trace: JSON.stringify(changedProof),
        })).status, 409);
      } finally { beforeLookup = undefined; }
      assert.equal((await store.get(changedId))?.status, "pending");
    });
    await t.test("payout stays locked and impossible task hashes are rejected before invoices", async () => {
      const before = lookups, beforeInvoices = invoices;
      assert.equal((await post("clearing.settle_contract", {
        ...args, payout_invoice: "lnbc-synthetic-not-payable",
      })).status, 503);
      assert.equal((await post("clearing.create_contract", {
        worker_pubkey: getPublicKey(worker), task_hash: "ff".repeat(32), amount_sats: 100,
      }, buyer)).status, 400);
      assert.equal(lookups, before);
      assert.equal(invoices, beforeInvoices);
    });
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [schema]);
    assert.deepEqual(tables.rows.map((r) => r.tablename), ["clearing_contracts"]);
  } finally {
    process.env.NODE_ENV = "test";
    if (server) await new Promise<void>((ok) => server!.close(() => ok()));
    await terminateZkVerifierWorker();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
    await (globalThis as unknown as {
      curve_bn128?: { terminate(): Promise<void> };
    }).curve_bn128?.terminate();
  }
});
