// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { pool } from "@workspace/db";
import { ClearingContracts } from "../services/clearingContracts";
import type { SettlementRouter } from "../services/settlement";
import { clearingController, clearingToolDefinitions } from "./clearing";
import { mcpToolDefinitions, registerMcpRoute } from "./mcp";
import { mcpToolPrices } from "../lib/mcp-pricing";
import { paymentEscrowToolDefinition } from "../lib/payment-escrow-tool";

const secret = "clearing-unit-test-only-secret";
const buyerKey = generateSecretKey(),
  workerKey = generateSecretKey(),
  otherKey = generateSecretKey();
const buyer = getPublicKey(buyerKey),
  worker = getPublicKey(workerKey);
const servers: Server[] = [];
const statements: string[] = [];
const trackedPool = new Proxy(pool, {
  get(target, key, receiver) {
    if (key === "query")
      return (...args: unknown[]) => {
        statements.push(String(args[0]));
        return Reflect.apply(target.query, target, args);
      };
    return Reflect.get(target, key, receiver);
  },
});
const store = new ClearingContracts(trackedPool);
type RpcReply = {
  result: {
    tools: unknown[];
    structuredContent: {
      escrow_id: string;
      status: string;
      settlement_available: boolean;
      funding_verified: boolean;
      warning: string;
      amount_sats: number;
      invoice: string;
      macaroon: string;
    };
  };
  error: {
    message: string;
    data: { escrow_id: string; zk_receipt_issued: boolean };
  };
};
let invoiceCalls = 0;
const funding: SettlementRouter = {
  isConfigured: () => true,
  activeProvider: () => "test",
  circuitState: () => "closed",
  createInvoice: async () => {
    invoiceCalls++;
    return {
      invoice: "lnbc-synthetic-not-payable",
      paymentHash: createHash("sha256").update(randomUUID()).digest("hex"),
      provider: "test",
    };
  },
  verifyPayment: async () => {
    throw new Error("Settlement must never run");
  },
};

async function listen(app: express.Express) {
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function fixture(router = funding, database = store) {
  const app = express();
  app.use(
    express.json({
      verify(req, _res, bytes) {
        (req as express.Request & { rawBody: Buffer }).rawBody =
          Buffer.from(bytes);
      },
    }),
  );
  let nextCalls = 0;
  app.use(
    "/mcp",
    clearingController({
      store: database,
      settlementRouter: router,
      secret,
      coreTools: mcpToolDefinitions,
    }),
    (_req, res) => {
      nextCalls++;
      res.json({ untouched: true });
    },
  );
  return {
    url: await listen(app),
    get nextCalls() {
      return nextCalls;
    },
  };
}

function envelope(name: string, args: unknown, id = randomUUID()) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}
function identity(url: string, body: string, key = buyerKey, age = 0) {
  return (
    "Nostr " +
    Buffer.from(
      JSON.stringify(
        finalizeEvent(
          {
            kind: 27235,
            content: "",
            created_at: Math.floor(Date.now() / 1000) - age,
            tags: [
              ["u", url],
              ["method", "POST"],
              ["payload", createHash("sha256").update(body).digest("hex")],
            ],
          },
          key,
        ),
      ),
    ).toString("base64")
  );
}
async function post(
  url: string,
  payload: unknown,
  key: Uint8Array | null = buyerKey,
  override?: string,
) {
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      ...(key
        ? { "X-Nostr-Authorization": override ?? identity(url, body, key) }
        : {}),
    },
  });
  return { status: response.status, body: (await response.json()) as RpcReply };
}
const createArgs = () => ({
  worker_pubkey: worker,
  task_hash: createHash("sha256").update(randomUUID()).digest("hex"),
  amount_sats: 123,
});

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  // Delete only this test run's random identity, never live or other test rows.
  await pool.query("DELETE FROM clearing_contracts WHERE buyer_pubkey=$1", [
    buyer,
  ]);
  await pool.end();
});

test("clearing catalog and dispatch never replace any sealed core contract", async () => {
  const before = JSON.stringify({
    mcpToolDefinitions,
    mcpToolPrices,
    paymentEscrowToolDefinition,
  });
  const f = await fixture();
  const listed = await post(
    f.url,
    { jsonrpc: "2.0", id: "list", method: "tools/list" },
    null,
  );
  assert.equal(listed.body.result.tools.length, 19);
  assert.deepEqual(
    listed.body.result.tools.slice(0, 17),
    JSON.parse(JSON.stringify(mcpToolDefinitions)),
  );
  assert.deepEqual(
    clearingToolDefinitions.map((t) => t.name),
    ["clearing.create_contract", "clearing.settle_contract"],
  );
  for (const name of ["clearing.create_contract", "clearing.settle_contract"]) {
    const tool = listed.body.result.tools.find(
      (tool: { name: string }) => tool.name === name,
    ) as { description?: unknown } | undefined;
    const description = tool?.description;
    assert.equal(typeof description, "string");
    assert.ok(
      String(description).includes(
          "Note: Contract state polling, listing, cancellations, and automated refunds are intentionally disabled in this namespace by design to enforce strict manual payout verification and prevent automated drain attacks.",
        ),
    );
  }
  const queries = statements.length,
    invoices = invoiceCalls;
  for (const tool of mcpToolDefinitions) {
    const result = await post(f.url, envelope(tool.name, {}), null);
    assert.deepEqual(result.body, { untouched: true });
  }
  assert.equal(f.nextCalls, 17);
  assert.equal(statements.length, queries);
  assert.equal(invoiceCalls, invoices);
  assert.equal(Object.keys(mcpToolPrices).length, 16);
  assert.equal(
    JSON.stringify({
      mcpToolDefinitions,
      mcpToolPrices,
      paymentEscrowToolDefinition,
    }),
    before,
  );
});

test("real PostgreSQL create/read preserves buyer identity and exact-request invoice retries", async () => {
  const f = await fixture(),
    input = createArgs();
  const request = envelope("clearing.create_contract", input);
  const before = invoiceCalls;
  const results = await Promise.all([
    post(f.url, request),
    post(f.url, request),
  ]);
  assert.ok(results.some((r) => r.status === 200));
  const retry = await post(f.url, request);
  assert.equal(retry.status, 200);
  assert.equal(invoiceCalls - before, 1);
  const data = retry.body.result.structuredContent;
  assert.equal(data.status, "pending");
  assert.equal(data.settlement_available, false);
  assert.equal(data.funding_verified, false);
  assert.match(data.warning, /Do not fund/);
  assert.equal(data.amount_sats, input.amount_sats);
  const row = await store.get(data.escrow_id);
  assert.ok(row);
  assert.equal(row.buyer_pubkey, buyer);
  assert.equal(row.worker_pubkey, worker);
  assert.equal(row.task_hash, input.task_hash);
  assert.equal(row.amount_sats, "123");
  assert.equal(row.invoice, data.invoice);
  assert.equal(row.status, "pending");
  assert.ok(
    Buffer.from(data.macaroon, "base64url")
      .toString()
      .includes("rpc = clearing.settle_contract"),
  );
  assert.ok(statements.every((sql) => sql.includes("clearing_contracts")));
});

test("NIP-98 authenticates exact URL/body/time and rejects missing or forged identity", async () => {
  const f = await fixture(),
    request = envelope("clearing.create_contract", createArgs());
  const body = JSON.stringify(request),
    before = invoiceCalls,
    reads = statements.length;
  const headers = [
    identity(f.url, body, buyerKey, 300),
    identity(f.url + "/wrong", body),
    identity(f.url, body + " "),
    "Nostr " +
      Buffer.from(
        JSON.stringify({ pubkey: buyer, sig: "00".repeat(64) }),
      ).toString("base64"),
  ];
  assert.equal((await post(f.url, request, null)).status, 401);
  for (const authorization of headers) {
    assert.equal(
      (await post(f.url, request, buyerKey, authorization)).status,
      401,
    );
  }
  assert.equal(invoiceCalls, before);
  assert.equal(statements.length, reads);
});

test("strict contract inputs reject buyer spoofing, unsafe amounts and invalid worker keys", async () => {
  const f = await fixture(),
    before = invoiceCalls,
    reads = statements.length,
    input = createArgs();
  for (const args of [
    { ...input, buyer_pubkey: getPublicKey(otherKey) },
    { ...input, amount_sats: 0 },
    { ...input, amount_sats: 1.1 },
    { ...input, amount_sats: Number.MAX_SAFE_INTEGER },
    { ...input, task_hash: "bad" },
    { ...input, worker_pubkey: "00".repeat(32) },
  ])
    assert.equal(
      (await post(f.url, envelope("clearing.create_contract", args))).status,
      400,
    );
  assert.equal(invoiceCalls, before);
  assert.equal(statements.length, reads);
});

test("settlement reads PostgreSQL, requires the worker and NEVER accepts an invented proof", async () => {
  const f = await fixture();
  const created = await post(
    f.url,
    envelope("clearing.create_contract", createArgs()),
  );
  const escrow_id = created.body.result.structuredContent.escrow_id;
  const original = await store.get(escrow_id);
  const before = invoiceCalls;
  const request = envelope("clearing.settle_contract", {
    escrow_id,
    execution_trace: JSON.stringify({ protocol: "groth16", verified: true }),
  });
  for (const key of [buyerKey, otherKey]) {
    assert.equal((await post(f.url, request, key)).status, 403);
  }
  const result = await post(f.url, request, workerKey);
  assert.equal(result.status, 503);
  assert.equal(
    result.body.error.message,
    "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE",
  );
  assert.equal(result.body.error.data.zk_receipt_issued, false);
  assert.deepEqual(await store.get(escrow_id), original);
  assert.equal(invoiceCalls, before);
  assert.equal(
    (
      await post(
        f.url,
        envelope("clearing.settle_contract", {
          escrow_id: randomUUID(),
          execution_trace: "anything",
        }),
        workerKey,
      )
    ).status,
    403,
  );
});

test("ambiguous invoice creation leaves one durable pending intent and never retries wallet I/O", async () => {
  let attempts = 0;
  const f = await fixture({
    ...funding,
    createInvoice: async () => {
      attempts++;
      throw new Error("private-provider-diagnostic");
    },
  });
  const request = envelope("clearing.create_contract", createArgs());
  const first = await post(f.url, request),
    retry = await post(f.url, request);
  assert.equal(first.status, 503);
  assert.ok(
    !JSON.stringify(first.body).includes("private-provider-diagnostic"),
  );
  assert.equal(retry.status, 503);
  assert.equal(attempts, 1);
  const row = await store.get(retry.body.error.data.escrow_id);
  assert.equal(row?.status, "pending");
  assert.equal(row?.invoice, null);
});

test("production MCP mounting advertises 19 tools while default core hosts retain 17", async () => {
  for (const enabled of [false, true]) {
    const app = express();
    app.use(express.json());
    registerMcpRoute(app, {
      settlementRouter: funding,
      sessionSecret: secret,
      ...(enabled ? { clearing: store } : {}),
    });
    const url = await listen(app);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discovery",
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as RpcReply;
    assert.equal(result.result.tools.length, enabled ? 19 : 17);
    assert.deepEqual(
      result.result.tools.slice(0, 17),
      JSON.parse(JSON.stringify(mcpToolDefinitions)),
    );
    if (enabled) {
      const call = async (
        name: string,
        args: unknown,
        key: Uint8Array | null,
      ) => {
        const request = envelope(name, args);
        const body = JSON.stringify({
          ...request,
          params: {
            ...request.params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        });
        const response = await fetch(url, {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": name,
            ...(key
              ? { "X-Nostr-Authorization": identity(url, body, key) }
              : {}),
          },
        });
        return {
          status: response.status,
          body: (await response.json()) as RpcReply,
        };
      };
      assert.equal(
        (await call("clearing.create_contract", createArgs(), null)).status,
        401,
      );
      const created = await call(
        "clearing.create_contract",
        createArgs(),
        buyerKey,
      );
      assert.equal(created.status, 200);
      const escrow_id = created.body.result.structuredContent.escrow_id;
      assert.equal((await store.get(escrow_id))?.buyer_pubkey, buyer);
      const args = { escrow_id, execution_trace: "untrusted execution proof" };
      assert.equal(
        (await call("clearing.settle_contract", args, buyerKey)).status,
        403,
      );
      const settled = await call("clearing.settle_contract", args, workerKey);
      assert.equal(settled.status, 503);
      assert.equal(
        settled.body.error.message,
        "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE",
      );
      assert.equal((await store.get(escrow_id))?.status, "pending");
    }
  }
});
