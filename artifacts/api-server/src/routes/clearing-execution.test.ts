// Real Groth16 and PostgreSQL; synthetic identities/invoices, NO wallet/network
// providers and NO imports, dispatch or tests of the 16 Fiduciary data tools.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { poseidon2 } from "poseidon-lite";
import { groth16 } from "snarkjs";
import { pool } from "@workspace/db";
import { ClearingContracts } from "../services/clearingContracts";
import type { SettlementRouter } from "../services/settlement";
import {
  CLEARING_SCHEME,
  CLEARING_RECEIPT_DOMAIN,
  CLEARING_VERIFICATION_KEY_ID,
  developmentClearingEnabled,
} from "../services/clearingExecution";
import { terminateZkVerifierWorker } from "../services/zkVerifierWorker";
import { payloadAttestation } from "../lib/payload-attestation";
import { clearingController } from "./clearing";

const key = generateKeyPairSync("ed25519");
// Synthetic test-only signing identity; never sign fixtures with live keys.
process.env.STRATIGRAPHY_PAYLOAD_PRIVATE_KEY = key.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const buyerKey = generateSecretKey(),
  workerKey = generateSecretKey();
const worker = getPublicKey(workerKey);
const taskHash = poseidon2([1n, 2n]).toString(16).padStart(64, "0");
const field =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const assets = resolve("generated-artifacts/clearing-development");
const schema = `clearing_dev_${randomBytes(10).toString("hex")}`;
let server: Server | undefined;
let client: (Pick<typeof pool, "query"> & { release(): void }) | undefined;
let url: string;
let store: ClearingContracts;
let invoiceCalls = 0,
  lookupCalls = 0;
let fundingMode: "paid" | "invalid" | "unavailable" | "wrong-provider" = "paid";
let expectedLookup: { id: string; hash: string } | undefined;
let lookupHook: (() => Promise<void>) | undefined;
type Reply = {
  result: {
    structuredContent: {
      escrow_id: string;
      receipt: { payload: string; signature: string; key_id: string };
    };
  };
  error: { message: string };
};
const router: SettlementRouter = {
  isConfigured: () => true,
  activeProvider: () => "development-test",
  circuitState: () => "closed",
  createInvoice: async () => {
    invoiceCalls++;
    return {
      invoice: "lnbc-synthetic-not-payable",
      paymentHash: createHash("sha256").update(randomUUID()).digest("hex"),
      provider: "development-test",
    };
  },
  verifyPayment: async (input) => {
    lookupCalls++;
    assert.ok(expectedLookup);
    assert.equal(input.paymentHash, expectedLookup.hash);
    assert.equal(
      input.expectedDescription,
      `A2A clearing ${expectedLookup.id} task ${taskHash}`,
    );
    assert.equal(input.expectedAmountMsats, 100000);
    assert.equal(input.expectedProvider, "development-test");
    assert.equal(input.asset, "btc-lightning");
    assert.equal(input.preimage, "");
    assert.equal(input.verificationMode, "merchant-lookup");
    await lookupHook?.();
    if (fundingMode === "invalid" || fundingMode === "unavailable")
      return fundingMode;
    return {
      settledAt: Math.floor(Date.now() / 1000),
      provider: fundingMode === "wrong-provider" ? "other" : "development-test",
      asset: "btc-lightning",
    };
  },
};

after(async () => {
  if (server)
    await new Promise<void>((ok, fail) =>
      server!.close((error) => (error ? fail(error) : ok())),
    );
  await terminateZkVerifierWorker();
  if (client) {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
  await pool.end();
  await (
    globalThis as unknown as {
      curve_bn128?: { terminate(): Promise<void> };
    }
  ).curve_bn128?.terminate();
});

async function post(
  name: string,
  args: object,
  signer = workerKey,
  options: { signedBody?: string; wrongUrl?: boolean; stale?: boolean } = {},
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  });
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000) - (options.stale ? 3600 : 0),
      tags: [
        ["u", options.wrongUrl ? url + "/wrong" : url],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256")
            .update(options.signedBody ?? body)
            .digest("hex"),
        ],
      ],
      content: "",
    },
    signer,
  );
  const response = await fetch(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Nostr-Authorization": `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
    },
  });
  return { status: response.status, body: (await response.json()) as Reply };
}

async function create() {
  const created = await post(
    "clearing.create_contract",
    {
      worker_pubkey: worker,
      task_hash: taskHash,
      amount_sats: 100,
    },
    buyerKey,
  );
  assert.equal(created.status, 200);
  assert.equal(
    (
      created.body.result.structuredContent as unknown as {
        settlement_available: boolean;
      }
    ).settlement_available,
    true,
  );
  const id: string = created.body.result.structuredContent.escrow_id;
  const row = await store.get(id);
  assert.ok(row?.payment_hash);
  expectedLookup = { id, hash: row.payment_hash };
  return id;
}

async function trace(id: string) {
  // Native snarkjs accepts array witness inputs; the legacy ambient type only
  // declares scalar inputs, so narrow that mismatch locally to this fixture.
  const input = {
    execution_trace_preimage: ["1", "2"],
    task_hash: BigInt(`0x${taskHash}`).toString(),
    escrow_binding: BigInt(`0x${id.replaceAll("-", "")}`).toString(),
  };
  const result = await groth16.fullProve(
    input as unknown as Record<string, string>,
    resolve(assets, "clearing_execution_js/clearing_execution.wasm"),
    resolve(assets, "clearing_execution.zkey"),
    undefined,
    undefined,
    { singleThread: true },
  );
  assert.deepEqual(result.publicSignals, [
    input.task_hash,
    input.escrow_binding,
  ]);
  return { scheme: CLEARING_SCHEME, ...result };
}

test("isolated local-development clearing settlement", async (t) => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(developmentClearingEnabled(), true);
  const manifest = JSON.parse(
    await readFile(resolve(assets, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.verification_key_sha256, CLEARING_VERIFICATION_KEY_ID);
  assert.equal(
    manifest.circuit_sha256,
    createHash("sha256")
      .update(await readFile("circuits/clearing_execution.circom"))
      .digest("hex"),
  );
  client = await pool.connect();
  // A fresh schema avoids changing ANY existing escrow, staking or data tables.
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}", pg_catalog`);
  store = new ClearingContracts(client);
  const app = express();
  app.use(
    express.json({
      verify(req, _res, bytes) {
        (req as express.Request & { rawBody: Buffer }).rawBody =
          Buffer.from(bytes);
      },
    }),
  );
  app.use(
    "/mcp",
    payloadAttestation(() => key.privateKey),
    clearingController({
      store,
      settlementRouter: router,
      secret: "development-test-secret",
      coreTools: [],
    }),
  );
  server = await new Promise<Server>((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/mcp`;
  const id = await create();
  const validTrace = await trace(id);
  const args = { escrow_id: id, execution_trace: JSON.stringify(validTrace) };

  await t.test(
    "the circuit rejects a wrong preimage and a half outside the 128-bit range",
    async () => {
      for (const halves of [
        ["3", "4"],
        [(1n << 128n).toString(), "2"],
      ]) {
        await assert.rejects(
          groth16.fullProve(
            {
              execution_trace_preimage: halves,
              task_hash:
                halves[0] === "3"
                  ? BigInt(`0x${taskHash}`).toString()
                  : poseidon2(halves.map(BigInt)).toString(),
              escrow_binding: BigInt(`0x${id.replaceAll("-", "")}`).toString(),
            } as unknown as Record<string, string>,
            resolve(assets, "clearing_execution_js/clearing_execution.wasm"),
            resolve(assets, "clearing_execution.zkey"),
            undefined,
            undefined,
            { singleThread: true },
          ),
        );
      }
    },
  );
  await t.test(
    "requires the exact worker, fresh signature, URL and body",
    async () => {
      const before = lookupCalls;
      assert.equal(
        (await post("clearing.settle_contract", args, buyerKey)).status,
        403,
      );
      for (const opts of [
        { signedBody: "{}" },
        { wrongUrl: true },
        { stale: true },
      ])
        assert.equal(
          (await post("clearing.settle_contract", args, workerKey, opts))
            .status,
          401,
        );
      assert.equal(lookupCalls, before);
      assert.equal((await store.get(id))?.status, "pending");
    },
  );
  await t.test(
    "rejects forged, tampered, extra-signal and wrong-task proofs before funding lookup",
    async () => {
      const before = lookupCalls;
      const original = validTrace as {
        scheme: string;
        proof: Record<string, unknown>;
        publicSignals: string[];
      };
      const invalid = [
        { verified: true },
        { ...original, proof: { ...original.proof, pi_a: ["0", "0", "1"] } },
        { ...original, publicSignals: ["1", original.publicSignals[1]] },
        { ...original, publicSignals: [...original.publicSignals, "0"] },
        {
          ...original,
          publicSignals: [
            "0" + original.publicSignals[0],
            original.publicSignals[1],
          ],
        },
        {
          ...original,
          publicSignals: [
            (BigInt(original.publicSignals[0]) + field).toString(),
            original.publicSignals[1],
          ],
        },
      ];
      for (const invalidTrace of invalid)
        assert.equal(
          (
            await post("clearing.settle_contract", {
              ...args,
              execution_trace: JSON.stringify(invalidTrace),
            })
          ).status,
          400,
        );
      assert.equal(lookupCalls, before);
      assert.equal((await store.get(id))?.status, "pending");
    },
  );
  await t.test(
    "rejects reuse of a valid proof for another escrow",
    async () => {
      const other = await create();
      const before = lookupCalls;
      assert.equal(
        (await post("clearing.settle_contract", { ...args, escrow_id: other }))
          .status,
        400,
      );
      assert.equal(lookupCalls, before);
      assert.equal((await store.get(other))?.status, "pending");
      expectedLookup = { id, hash: (await store.get(id))!.payment_hash! };
    },
  );
  await t.test(
    "rejects unpaid, unavailable and wrong-provider funding without a write",
    async () => {
      for (const mode of [
        "invalid",
        "unavailable",
        "wrong-provider",
      ] as const) {
        fundingMode = mode;
        assert.equal(
          (await post("clearing.settle_contract", args)).status,
          mode === "unavailable" ? 503 : 409,
        );
        const row = await store.get(id);
        assert.equal(row?.status, "pending");
        assert.equal(row?.settlement_receipt, null);
      }
      fundingMode = "paid";
    },
  );
  await t.test(
    "production and hosted deployment modes cannot activate the development verifier",
    async () => {
      const before = lookupCalls;
      for (const env of [
        { NODE_ENV: "production", CLEARING_DEVELOPMENT_SETTLEMENT: "1" },
        {
          NODE_ENV: "development",
          CLEARING_DEVELOPMENT_SETTLEMENT: "1",
          REPLIT_DEPLOYMENT: "1",
        },
        { NODE_ENV: "development" },
      ])
        assert.equal(developmentClearingEnabled(env), false);
      process.env.NODE_ENV = "production";
      try {
        const result = await post("clearing.settle_contract", args);
        assert.equal(result.status, 400);
        assert.equal(
          result.body.error.message,
          "CLEARING_INVALID_EXECUTION_PROOF",
        );
      } finally {
        process.env.NODE_ENV = "test";
      }
      assert.equal(lookupCalls, before);
      assert.equal((await store.get(id))?.status, "pending");
    },
  );
  await t.test(
    "atomic PostgreSQL write settles once and returns a verifiable signed receipt",
    async () => {
      const invoices = invoiceCalls;
      const replies = await Promise.all([
        post("clearing.settle_contract", args),
        post("clearing.settle_contract", args),
      ]);
      for (const result of replies) assert.equal(result.status, 200);
      const data = replies[0].body.result.structuredContent;
      assert.deepEqual(data, replies[1].body.result.structuredContent);
      const receipt = data.receipt;
      assert.equal(
        verify(
          null,
          Buffer.from(CLEARING_RECEIPT_DOMAIN + receipt.payload),
          key.publicKey,
          Buffer.from(receipt.signature, "base64"),
        ),
        true,
      );
      assert.equal(
        verify(
          null,
          Buffer.from(CLEARING_RECEIPT_DOMAIN + receipt.payload + " "),
          key.publicKey,
          Buffer.from(receipt.signature, "base64"),
        ),
        false,
      );
      const claims = JSON.parse(receipt.payload);
      assert.equal(claims.escrow_id, id);
      assert.equal(claims.task_hash, taskHash);
      assert.equal(claims.worker_pubkey, worker);
      assert.equal(claims.verification_key_id, CLEARING_VERIFICATION_KEY_ID);
      assert.equal(claims.guarantee, "knowledge-of-hash-preimage");
      assert.equal(claims.development_only, true);
      assert.equal(claims.payout_executed, false);
      assert.equal(claims.legal_indemnity_granted, false);
      const row = await store.get(id);
      assert.equal(row?.status, "settled");
      assert.equal(row?.proof_digest, claims.proof_digest);
      assert.deepEqual(JSON.parse(row!.settlement_receipt!), receipt);
      assert.equal(row?.settled_at?.toISOString(), claims.settled_at);
      const lookups = lookupCalls;
      const retried = await post("clearing.settle_contract", args);
      assert.deepEqual(retried.body.result.structuredContent, data);
      assert.equal(lookupCalls, lookups);
      assert.equal(invoiceCalls, invoices);
      // Stored receipt remains historical evidence, not a fresh payment lookup.
      const otherProof = await trace(id);
      assert.equal(
        (
          await post("clearing.settle_contract", {
            ...args,
            execution_trace: JSON.stringify(otherProof),
          })
        ).status,
        409,
      );
    },
  );
  await t.test(
    "a concurrent contract mutation cannot pass the settlement compare-and-set",
    async () => {
      const changedId = await create();
      const changedTrace = await trace(changedId);
      lookupHook = async () => {
        await client!.query(
          "UPDATE clearing_contracts SET task_hash=$2 WHERE escrow_id=$1",
          [changedId, "01".repeat(32)],
        );
      };
      try {
        assert.equal(
          (
            await post("clearing.settle_contract", {
              escrow_id: changedId,
              execution_trace: JSON.stringify(changedTrace),
            })
          ).status,
          409,
        );
      } finally {
        lookupHook = undefined;
      }
      const row = await store.get(changedId);
      assert.equal(row?.status, "pending");
      assert.equal(row?.settlement_receipt, null);
    },
  );
  await t.test(
    "only the isolated clearing table exists in the test schema",
    async () => {
      const tables = await client!.query(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
        [schema],
      );
      assert.deepEqual(
        tables.rows.map((r) => r.tablename),
        ["clearing_contracts"],
      );
    },
  );
});
