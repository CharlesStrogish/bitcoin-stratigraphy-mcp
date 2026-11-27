import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import express, { type Request } from "express";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { pool } from "@workspace/db";
import {
  McpUrlElicitation,
  UrlHandoffError,
  clientSupportsUrlElicitation,
  URL_HANDOFF_TTL_MS,
  URL_HANDOFF_METHOD,
  URL_HANDOFF_STATUS,
  URL_HANDOFF_PAGE,
} from "../../src/lib/mcp-url-elicitation";
import {
  memoryUrlElicitationStore,
  postgresUrlElicitationStore,
} from "../../src/lib/mcp-url-elicitation-store";
import { registerMcpUrlElicitationRoutes } from "../../src/routes/mcp-url-elicitation";
import { registerFiatMintRoutes } from "../../src/routes/fiat-mint";
import { registerAgplWaiverRoutes } from "../../src/routes/agpl-waivers";
import { WaiverError } from "../../src/services/agplWaivers";
import type { FiatMint } from "../../src/services/fiatMint";
import type { SettlementRouter } from "../../src/services/settlement";
import {
  registerMcpRoute,
  mcpToolDefinitions,
  indexedContractTestFixture,
} from "../../src/routes/mcp";
import { registerToolIntegrityRoute } from "../../src/routes/tool-integrity";
import { createMemoryMacaroonUsageStore } from "../../src/lib/macaroon-usage-store";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import { McpTasksExtension } from "../../src/lib/mcp-tasks-extension";
import { memoryMcpTaskStore } from "../../src/lib/mcp-task-store";
import { powFetch } from "../helpers/pow-fetch";
import { checkoutHandoffHtml } from "../../src/lib/mcp-checkout-page";

after(async () => {
  await pool.end();
});
const modern = "2026-07-28",
  legacy = "2025-11-25";
const capable = { elicitation: { url: {} } };
const ownerKey = randomBytes(32).toString("hex");
const otherKey = randomBytes(32).toString("hex");
const secret = "synthetic-elicitation-unit-secret-not-a-wallet";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const proof = (key = ownerKey) => ({ "X-MCP-Owner-Key": key });
function fakeRequest(headers: Record<string, string>, body?: unknown) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method: "POST",
    originalUrl: "/mcp",
    protocol: "https",
    headers: { host: "handoff.test", ...normalized },
    body,
    get: (name: string) =>
      name.toLowerCase() === "host"
        ? "handoff.test"
        : normalized[name.toLowerCase()],
    header: (name: string) =>
      name.toLowerCase() === "host"
        ? "handoff.test"
        : normalized[name.toLowerCase()],
  } as unknown as Request;
}
const errorStatus = (status: number) => (error: unknown) =>
  error instanceof UrlHandoffError && error.status === status;

async function fixture() {
  let clock = Date.now(),
    checkoutCalls = 0,
    quoteCalls = 0,
    claimCalls = 0,
    invoiceCalls = 0;
  let ready = false,
    paid = false,
    failCheckout = false;
  const store = memoryUrlElicitationStore();
  const service = new McpUrlElicitation(
    store,
    () => secret,
    () => clock,
  );
  const app = express();
  app.use(express.json());
  registerMcpUrlElicitationRoutes(app, service);
  let base = "";
  registerFiatMintRoutes(
    app,
    {
      checkout: async () => {
        checkoutCalls++;
        if (failCheckout) throw new Error("synthetic unknown outcome");
        return "https://checkout.stripe.com/c/pay/synthetic";
      },
      status: async () => (ready ? "ready" : "checkout"),
      claim: async () =>
        ready
          ? {
              macaroon: "synthetic-verified-scanner-grant",
              credits: 100,
              amount_sats: 100000,
              valid_until: Math.floor(Date.now() / 1000) + 3600,
              scope: "/api/scanner",
            }
          : null,
    } as unknown as FiatMint,
    () => base,
  );
  const quoteId = randomUUID();
  registerAgplWaiverRoutes(app, {
    quote: async () => {
      quoteCalls++;
      return {
        quote_id: quoteId,
        tier: "swarm_monthly",
        licensee_name: "Synthetic",
        licensee_identifier: "test-only",
        quoted_sats: 10,
        settlement_address: "synthetic-no-real-address",
        usd_basis: 2500,
        btc_spot_usd: 25000000,
        min_confirmations: 2,
        terms_sha256: sha("terms"),
        created_at: new Date(clock).toISOString(),
        expires_at: new Date(clock + 21600000).toISOString(),
        derivation_index: 0,
      };
    },
    claim: async (input: { quote_id: string; txid: string }) => {
      claimCalls++;
      if (!paid || input.quote_id !== quoteId)
        throw new WaiverError(409, "insufficient_confirmations");
      return {
        waiver_id: randomUUID(),
        signature: "synthetic-server-confirmed-signature",
        txid: input.txid,
        vout: 0,
      };
    },
  });
  const settlementRouter: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "synthetic",
    circuitState: () => "closed",
    createInvoice: async () => {
      invoiceCalls++;
      return {
        invoice: "lnbc1synthetic",
        paymentHash: sha("invoice"),
        provider: "synthetic",
      };
    },
    verifyPayment: async () => "invalid",
  };
  registerToolIntegrityRoute(
    app,
    mcpToolDefinitions,
    generateKeyPairSync("ed25519").privateKey,
  );
  registerMcpRoute(app, {
    urlElicitation: service,
    settlementRouter,
    sessionSecret: secret,
    x402ResourceServer: null,
    usageStore: createMemoryMacaroonUsageStore(),
    revocationStore: createMemoryMacaroonRevocationStore(),
    stratigraphyBackend: indexedContractTestFixture,
    tasksExtension: new McpTasksExtension(memoryMcpTaskStore()),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: base,
        ...proof(),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (response.headers.get("content-type") ?? "").includes(
      "application/json",
    )
      ? ((await response.json()) as any)
      : await response.text();
    return { response, data };
  };
  const rpc = async (
    version: string,
    intent = "agpl_waiver_checkout",
    caps: unknown = capable,
    state?: string,
    key = ownerKey,
  ) => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: URL_HANDOFF_METHOD,
      params: {
        intent,
        ...(state ? { requestState: state } : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientCapabilities": caps,
        },
      },
    };
    return request("/mcp", body, {
      ...proof(key),
      "MCP-Protocol-Version": version,
      "Mcp-Method": URL_HANDOFF_METHOD,
    });
  };
  return {
    app,
    service,
    store,
    base,
    request,
    rpc,
    quoteId,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    ready: () => {
      ready = true;
    },
    pay: () => {
      paid = true;
    },
    fail: () => {
      failCheckout = true;
    },
    counts: () => ({ checkoutCalls, quoteCalls, claimCalls, invoiceCalls }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("capability helper accepts explicit URL capability only", () => {
  for (const value of [
    undefined,
    null,
    {},
    { elicitation: {} },
    { elicitation: { form: {} } },
    { elicitation: { url: false } },
  ])
    assert.equal(clientSupportsUrlElicitation(value), false);
  assert.equal(clientSupportsUrlElicitation(capable), true);
});

test("quote recovery uses a valid Unicode-sets HTML pattern for UUIDs", () => {
  const pattern = checkoutHandoffHtml("synthetic-nonce").match(
    /id="quote-id" pattern="([^"]+)"/,
  )?.[1];
  assert.ok(pattern);
  // HTML pattern uses the v flag: a bare trailing '-' in a class is invalid.
  const uuid = new RegExp("^(?:" + pattern + ")$", "v");
  assert.equal(uuid.test(randomUUID()), true);
  assert.equal(uuid.test("-".repeat(36)), false);
  assert.equal(uuid.test("not-a-quote"), false);
});

test("ownership is cryptographic, stable and never a bare session or self-declared client", () => {
  const service = new McpUrlElicitation(
    memoryUrlElicitationStore(),
    () => secret,
  );
  const owner = service.ownerHash(fakeRequest(proof()));
  assert.match(owner, /^[0-9a-f]{64}$/);
  assert.notEqual(owner, ownerKey);
  assert.equal(owner, service.ownerHash(fakeRequest(proof())));
  assert.notEqual(owner, service.ownerHash(fakeRequest(proof(otherKey))));
  for (const headers of [
    { "Mcp-Session-Id": ownerKey },
    { "X-Agent-Id": ownerKey },
    proof("short"),
  ])
    assert.throws(
      () => service.ownerHash(fakeRequest(headers)),
      errorStatus(403),
    );
  assert.throws(
    () =>
      service.ownerHash(
        fakeRequest({ ...proof(), "X-Nostr-Authorization": "Nostr forged" }),
      ),
    errorStatus(403),
  );
  assert.throws(
    () =>
      new McpUrlElicitation(undefined, () => undefined).ownerHash(
        fakeRequest(proof()),
      ),
    errorStatus(503),
  );
});

test("fresh NIP-98 owner binding rejects URL/method/body tampering and never stores private material", async () => {
  const key = generateSecretKey(),
    now = Date.now(),
    body = { jsonrpc: "2.0", id: 7, method: URL_HANDOFF_METHOD };
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(now / 1000),
      content: "",
      tags: [
        ["u", "https://handoff.test/mcp"],
        ["method", "POST"],
        ["payload", sha(JSON.stringify(body))],
      ],
    },
    key,
  );
  const header =
    "Nostr " + Buffer.from(JSON.stringify(event)).toString("base64");
  const service = new McpUrlElicitation(
    memoryUrlElicitationStore(),
    () => secret,
    () => now,
  );
  const request = fakeRequest({ "X-Nostr-Authorization": header }, body);
  const owner = service.ownerHash(request);
  assert.equal(owner, service.ownerHash(request));
  const row = await service.create("agpl_waiver_checkout", owner);
  assert.equal(JSON.stringify(row).includes(event.pubkey), false);
  assert.equal(
    JSON.stringify(service.elicitation(row)).includes(event.sig),
    false,
  );
  assert.throws(
    () =>
      service.ownerHash({ ...request, body: { ...body, id: 8 } } as Request),
    errorStatus(403),
  );
  assert.throws(
    () => service.ownerHash({ ...request, method: "GET" } as Request),
    errorStatus(403),
  );
  assert.throws(
    () =>
      service.ownerHash({ ...request, originalUrl: "/different" } as Request),
    errorStatus(403),
  );
});

for (const intent of [
  "scanner_pack_checkout",
  "agpl_waiver_checkout",
] as const) {
  for (const version of [legacy, modern]) {
    test(`${version} ${intent}: URL-mode is gated, owner-bound, finite and free of checkout side effects`, async () => {
      const f = await fixture();
      try {
        const before = await f.request("/.well-known/integrity.json");
        assert.equal(before.response.status, 200);
        assert.equal(Object.keys(before.data.tools).length, 17);
        const { response, data } = await f.rpc(version, intent);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const elicitation =
          version === legacy
            ? data.error.data.elicitations[0]
            : Object.values(data.result.inputRequests).map(
                (v: any) => v.params,
              )[0];
        if (version === legacy) assert.equal(data.error.code, -32042);
        else {
          assert.equal(data.error, undefined);
          assert.equal(data.result.resultType, "input_required");
          assert.equal(typeof data.result.requestState, "string");
        }
        assert.equal(elicitation.mode, "url");
        assert.equal(elicitation.requestedSchema, undefined);
        assert.match(elicitation.elicitationId, /^[0-9a-f-]{36}$/);
        assert.ok(elicitation.message.length > 40);
        const url = new URL(elicitation.url);
        assert.equal(url.origin, "https://bitcoinstratigraphy.com");
        assert.equal(url.pathname, URL_HANDOFF_PAGE);
        assert.equal(
          url.searchParams.get("handoff"),
          elicitation.elicitationId,
        );
        assert.equal(
          url.searchParams.get("intent"),
          intent === "agpl_waiver_checkout" ? "agpl_waiver" : "scanner_pack",
        );
        assert.equal(JSON.stringify(data).includes(ownerKey), false);
        assert.equal(JSON.stringify(data).includes(secret), false);
        assert.deepEqual(f.counts(), {
          checkoutCalls: 0,
          quoteCalls: 0,
          claimCalls: 0,
          invoiceCalls: 0,
        });
        const page = await f.request(url.pathname + url.search);
        assert.equal(page.response.status, 200);
        assert.match(
          page.data,
          /No purchase or Bitcoin address has been created/,
        );
        assert.deepEqual(f.counts(), {
          checkoutCalls: 0,
          quoteCalls: 0,
          claimCalls: 0,
          invoiceCalls: 0,
        });
        const status = await f.request(
          URL_HANDOFF_STATUS + "/" + elicitation.elicitationId,
        );
        assert.equal(status.data.status, "pending");
        assert.equal(
          status.data.expiresAt - status.data.createdAt,
          URL_HANDOFF_TTL_MS,
        );
        assert.equal(status.data.ownerHash, undefined);
        assert.equal(status.data.referenceId, undefined);
        assert.equal(status.response.headers.get("cache-control"), "no-store");
        assert.equal(
          (
            await f.request(
              URL_HANDOFF_STATUS + "/" + elicitation.elicitationId,
              undefined,
              proof(otherKey),
            )
          ).response.status,
          404,
        );
        const retry = await f.rpc(
          version,
          intent,
          capable,
          elicitation.elicitationId,
        );
        assert.deepEqual(retry.data, data);
        const completion = version === legacy ? data.error.data : data.result;
        assert.equal(completion.completion_strategy, "poll_and_retry");
        assert.equal(
          completion.status_endpoint,
          URL_HANDOFF_STATUS + "/" + elicitation.elicitationId,
        );
        assert.deepEqual(
          (await f.request("/.well-known/integrity.json")).data,
          before.data,
        );
      } finally {
        await f.close();
      }
    });
  }
}

for (const version of [legacy, modern]) {
  test(`${version} non-capable clients never receive URL elicitation or alter paid-tool 402 envelopes`, async () => {
    const f = await fixture();
    try {
      for (const caps of [{}, { elicitation: { form: {} } }]) {
        const result = await f.rpc(version, "agpl_waiver_checkout", caps);
        assert.equal(result.data.error.code, -32601);
        assert.equal(result.data.error.data?.elicitations, undefined);
        assert.equal(result.data.result?.inputRequests, undefined);
      }
      const body = {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mesh.get_status",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      };
      const response = await powFetch(f.base + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "MCP-Protocol-Version": version,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "mesh.get_status",
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 402);
      const data = (await response.json()) as any;
      const challenge = version === modern ? data.error.data : data;
      assert.equal(data.error.code, version === modern ? 402 : -32002);
      assert.equal(challenge.next_action.reason, "toll_required");
      assert.equal(challenge.next_action.payment.macaroon, challenge.macaroon);
      assert.equal(challenge.next_action.payment.invoice, challenge.invoice);
      assert.equal(
        challenge.next_action.payment.payment_hash,
        challenge.payment_hash,
      );
      assert.equal(challenge.elicitations, undefined);
      assert.match(
        response.headers.get("www-authenticate")!,
        /^L402 macaroon=/,
      );
    } finally {
      await f.close();
    }
  });
}

test("legacy initialize capability consent survives finite responses and remains owner-bound", async () => {
  const f = await fixture();
  try {
    const initialized = await f.request(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: legacy,
          capabilities: capable,
          clientInfo: { name: "url-test", version: "1" },
        },
      },
      { "MCP-Protocol-Version": legacy },
    );
    assert.equal(initialized.response.status, 200);
    assert.equal(initialized.data.result.protocolVersion, legacy);
    const body = {
      jsonrpc: "2.0",
      id: 2,
      method: URL_HANDOFF_METHOD,
      params: { intent: "scanner_pack_checkout" },
    };
    const result = await f.request("/mcp", body, {
      "MCP-Protocol-Version": legacy,
    });
    assert.equal(result.data.error.code, -32042);
    assert.equal(
      (
        await f.request("/mcp", body, {
          "MCP-Protocol-Version": legacy,
          ...proof(otherKey),
        })
      ).data.error.code,
      -32601,
    );
    assert.equal(
      (await f.rpc(legacy, "scanner_pack_checkout", {})).data.error.code,
      -32601,
    );
    f.advance(URL_HANDOFF_TTL_MS);
    assert.equal(
      (await f.request("/mcp", body, { "MCP-Protocol-Version": legacy })).data
        .error.code,
      -32601,
    );
  } finally {
    await f.close();
  }
});

test("non-capable initialize remains unchanged even when handoff storage is unavailable", async () => {
  const f = await fixture();
  try {
    f.store.remember = async () => {
      throw new Error("must not touch URL handoff storage");
    };
    const result = await f.request(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: legacy,
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: "form-only", version: "1" },
        },
      },
      { "MCP-Protocol-Version": legacy },
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.data.result.protocolVersion, legacy);
    assert.equal(result.data.error, undefined);
  } finally {
    await f.close();
  }
});

test("durable records survive service replacement; expiration and wrong-owner completion fail closed", async () => {
  const store = memoryUrlElicitationStore();
  let clock = Date.now();
  const first = new McpUrlElicitation(
    store,
    () => secret,
    () => clock,
  );
  const owner = first.ownerHash(fakeRequest(proof()));
  const row = await first.create("agpl_waiver_checkout", owner);
  const second = new McpUrlElicitation(
    store,
    () => secret,
    () => clock,
  );
  assert.deepEqual(
    await second.getHandoffStatus(row.elicitationId, owner),
    row,
  );
  await assert.rejects(
    second.getHandoffStatus(row.elicitationId, "0".repeat(64)),
    errorStatus(404),
  );
  await assert.rejects(
    second.markHandoffCompleted(
      row.elicitationId,
      "0".repeat(64),
      "waiver:" + randomUUID(),
    ),
    errorStatus(404),
  );
  await assert.rejects(
    second.markHandoffCompleted(
      row.elicitationId,
      owner,
      "waiver:" + randomUUID(),
    ),
    errorStatus(403),
  );
  clock += URL_HANDOFF_TTL_MS;
  await assert.rejects(
    second.getHandoffStatus(row.elicitationId, owner),
    errorStatus(410),
  );
  assert.equal((await store.get(row.elicitationId))!.status, "expired");
  await assert.rejects(
    second.markHandoffCompleted(
      row.elicitationId,
      owner,
      "waiver:" + randomUUID(),
    ),
    errorStatus(410),
  );
});

test("expired polling returns no owner or payment material and cannot renew a handoff", async () => {
  const f = await fixture();
  try {
    const created = await f.rpc(modern);
    const id = created.data.result.requestState;
    f.advance(URL_HANDOFF_TTL_MS);
    const expired = await f.request(URL_HANDOFF_STATUS + "/" + id);
    assert.equal(expired.response.status, 410);
    assert.equal(expired.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(expired.data), ["error"]);
    assert.equal(
      (await f.rpc(modern, "agpl_waiver_checkout", capable, id)).response
        .status,
      410,
    );
    assert.deepEqual(f.counts(), {
      checkoutCalls: 0,
      quoteCalls: 0,
      claimCalls: 0,
      invoiceCalls: 0,
    });
  } finally {
    await f.close();
  }
});

test("waiver checkout requires explicit same-owner browser action and verified claim, without duplicate allocation", async () => {
  const f = await fixture();
  try {
    const created = await f.rpc(modern),
      id = created.data.result.requestState;
    const headers = { "X-MCP-Elicitation-Id": id };
    const body = {
      tier: "swarm_monthly",
      licensee_name: "Synthetic",
      licensee_identifier: "test-only",
      terms_accepted: true,
    };
    assert.equal(
      (
        await f.request("/api/v1/waivers/quote", body, {
          ...headers,
          ...proof(otherKey),
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await f.request("/api/v1/waivers/quote", body, {
          ...headers,
          origin: "https://foreign.test",
        })
      ).response.status,
      403,
    );
    assert.equal(f.counts().quoteCalls, 0);
    const quotes = await Promise.all([
      f.request("/api/v1/waivers/quote", body, headers),
      f.request("/api/v1/waivers/quote", body, headers),
    ]);
    assert.deepEqual(quotes.map((q) => q.response.status).sort(), [200, 409]);
    assert.equal(f.counts().quoteCalls, 1);
    const unknown = await f.request(
      "/api/v1/waivers/claim",
      { quote_id: randomUUID(), txid: "0".repeat(64) },
      headers,
    );
    assert.equal(unknown.response.status, 403);
    const claim = { quote_id: f.quoteId, txid: "0".repeat(64) };
    assert.equal(
      (await f.request("/api/v1/waivers/claim", claim, headers)).response
        .status,
      409,
    );
    assert.equal(
      (await f.request(URL_HANDOFF_STATUS + "/" + id)).data.status,
      "pending",
    );
    f.pay();
    const certificate = await f.request(
      "/api/v1/waivers/claim",
      claim,
      headers,
    );
    assert.equal(certificate.response.status, 200);
    assert.equal(
      certificate.data.signature,
      "synthetic-server-confirmed-signature",
    );
    const status = await f.request(URL_HANDOFF_STATUS + "/" + id);
    assert.equal(status.data.status, "completed");
    assert.equal(status.data.referenceId, undefined);
    const retry = await f.rpc(modern, "agpl_waiver_checkout", capable, id);
    assert.equal(retry.data.result.resultType, "complete");
    assert.equal(retry.data.result.inputRequests, undefined);
    assert.equal(f.counts().quoteCalls, 1);
  } finally {
    await f.close();
  }
});

test("scanner completion follows original owner-checked fulfillment, not client-supplied claims", async () => {
  const f = await fixture();
  try {
    const created = await f.rpc(legacy, "scanner_pack_checkout"),
      id = created.data.error.data.elicitations[0].elicitationId;
    const headers = { "X-MCP-Elicitation-Id": id };
    const checkout = await f.request("/api/fiat-mint", {}, headers);
    assert.equal(checkout.response.status, 200);
    const cookie = checkout.response.headers.get("set-cookie")!.split(";")[0]!;
    const buyerHeaders = { ...headers, cookie };
    assert.equal(f.counts().checkoutCalls, 1);
    assert.equal(
      (await f.request("/api/fiat-mint", {}, buyerHeaders)).response.status,
      409,
    );
    assert.equal(
      (await f.request("/api/fiat-mint/status", {}, headers)).response.status,
      403,
    );
    const forged = await f.request(
      "/api/fiat-mint/status",
      { status: "ready", completed: true },
      buyerHeaders,
    );
    assert.equal(forged.data.status, "checkout");
    assert.equal(
      (await f.request(URL_HANDOFF_STATUS + "/" + id)).data.status,
      "pending",
    );
    f.ready();
    assert.equal(
      (await f.request("/api/fiat-mint/status", {}, buyerHeaders)).data.status,
      "ready",
    );
    assert.equal(
      (await f.request(URL_HANDOFF_STATUS + "/" + id)).data.status,
      "completed",
    );
    const retry = await f.rpc(legacy, "scanner_pack_checkout", capable, id);
    assert.equal(retry.data.result.resultType, "complete");
    assert.equal(retry.data.error, undefined);
    const row = await f.store.get(id);
    assert.equal(JSON.stringify(row).includes(cookie.split("=")[1]!), false);
    assert.match(row!.referenceId!, /^scanner:[0-9a-f]{64}$/);
  } finally {
    await f.close();
  }
});

test("unknown checkout outcomes stay reserved and cannot start a second purchase", async () => {
  const f = await fixture();
  try {
    const created = await f.rpc(modern, "scanner_pack_checkout"),
      id = created.data.result.requestState;
    f.fail();
    const headers = { "X-MCP-Elicitation-Id": id };
    assert.equal(
      (await f.request("/api/fiat-mint", {}, headers)).response.status,
      503,
    );
    assert.equal(
      (await f.request("/api/fiat-mint", {}, headers)).response.status,
      409,
    );
    assert.equal(f.counts().checkoutCalls, 1);
    assert.equal(
      (await f.request(URL_HANDOFF_STATUS + "/" + id)).data.status,
      "pending",
    );
  } finally {
    await f.close();
  }
});

test("existing custom form remediation contract stays unchanged and never becomes payment form-mode", async () => {
  const extension = new McpTasksExtension(memoryMcpTaskStore());
  const task = await extension.create(
    "proof.submit",
    {},
    "Correct the tool arguments",
  );
  assert.equal(task.status, "input_required");
  const request = Object.values(task.inputRequests!)[0] as any;
  assert.deepEqual(request, {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Correct the tool arguments",
      requestedSchema: {
        type: "object",
        properties: {
          arguments: {
            type: "string",
            description: "Corrected tool arguments as a JSON object string",
          },
        },
        required: ["arguments"],
      },
    },
  });
});

test("opaque state confers no authority; forged sessions and changed intent cannot reuse it", async () => {
  const f = await fixture();
  try {
    const created = await f.rpc(modern),
      id = created.data.result.requestState;
    assert.equal(
      (
        await f.request(URL_HANDOFF_STATUS + "/" + id, undefined, {
          "X-MCP-Owner-Key": "",
          "Mcp-Session-Id": ownerKey,
        })
      ).response.status,
      403,
    );
    assert.equal(
      (await f.rpc(modern, "agpl_waiver_checkout", capable, id, otherKey))
        .response.status,
      404,
    );
    assert.equal(
      (await f.rpc(modern, "scanner_pack_checkout", capable, id)).response
        .status,
      403,
    );
    assert.equal(
      (await f.rpc(modern, "agpl_waiver_checkout", capable, "not-a-uuid"))
        .response.status,
      404,
    );
    assert.equal(
      (await f.rpc(modern, "https://foreign.test")).response.status,
      400,
    );
    assert.equal(f.counts().checkoutCalls + f.counts().quoteCalls, 0);
  } finally {
    await f.close();
  }
});

test("an expired human checkout cannot allocate a quote or create a Stripe session", async () => {
  const f = await fixture();
  try {
    for (const intent of ["scanner_pack_checkout", "agpl_waiver_checkout"]) {
      const created = await f.rpc(modern, intent),
        id = created.data.result.requestState;
      f.advance(URL_HANDOFF_TTL_MS);
      const response = await f.request(
        intent === "scanner_pack_checkout"
          ? "/api/fiat-mint"
          : "/api/v1/waivers/quote",
        {},
        { "X-MCP-Elicitation-Id": id },
      );
      assert.equal(response.response.status, 410);
    }
    assert.deepEqual(f.counts(), {
      checkoutCalls: 0,
      quoteCalls: 0,
      claimCalls: 0,
      invoiceCalls: 0,
    });
  } finally {
    await f.close();
  }
});

test("completion is idempotent under racing workers and cannot rebind an existing checkout", async () => {
  const store = memoryUrlElicitationStore();
  const a = new McpUrlElicitation(store, () => secret),
    b = new McpUrlElicitation(store, () => secret);
  const owner = a.ownerHash(fakeRequest(proof()));
  const row = await a.create("agpl_waiver_checkout", owner),
    reference = "waiver:" + randomUUID();
  await a.bindReference(row.elicitationId, owner, reference);
  await assert.rejects(
    b.bindReference(row.elicitationId, owner, "waiver:" + randomUUID()),
    errorStatus(409),
  );
  const completed = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? a : b).markHandoffCompleted(
        row.elicitationId,
        owner,
        reference,
      ),
    ),
  );
  assert.ok(completed.every((result) => result.status === "completed"));
  assert.equal(new Set(completed.map((result) => result.completedAt)).size, 1);
  assert.equal((await store.get(row.elicitationId))!.revision, 2);
});

test("cancelled handoffs cannot be completed or revived", async () => {
  const store = memoryUrlElicitationStore(),
    service = new McpUrlElicitation(store, () => secret);
  const owner = service.ownerHash(fakeRequest(proof())),
    row = await service.create("scanner_pack_checkout", owner);
  await store.replace({ ...row, status: "cancelled", revision: 1 }, 0);
  await assert.rejects(
    service.getHandoffStatus(row.elicitationId, owner),
    errorStatus(409),
  );
  await assert.rejects(
    service.markHandoffCompleted(
      row.elicitationId,
      owner,
      "scanner:" + "0".repeat(64),
    ),
    errorStatus(409),
  );
});

test("durable storage errors never fall back to an unpersisted handoff", async () => {
  const store = memoryUrlElicitationStore();
  store.create = async () => {
    throw new Error("synthetic store down");
  };
  const service = new McpUrlElicitation(store, () => secret);
  await assert.rejects(
    service.create(
      "scanner_pack_checkout",
      service.ownerHash(fakeRequest(proof())),
    ),
    /synthetic store down/,
  );
});

test("PostgreSQL adapter persists across new store instances and commits before admission returns", async () => {
  const rows = new Map<string, any>(),
    clients = new Map<string, any>(),
    queries: string[] = [];
  const query = async (sql: string, values: any[] = []) => {
    queries.push(sql);
    if (sql.includes("SELECT count(*)"))
      return { rows: [{ total: 0, owned: 0 }] };
    if (sql.startsWith("INSERT INTO mcp_url_handoffs"))
      rows.set(values[0], JSON.parse(values[3]));
    if (sql.startsWith("SELECT state FROM mcp_url_handoffs"))
      return {
        rows: rows.has(values[0])
          ? [{ state: structuredClone(rows.get(values[0])) }]
          : [],
      };
    if (sql.startsWith("UPDATE mcp_url_handoffs")) {
      const current = rows.get(values[2]);
      if (current?.revision !== values[4] || current.ownerHash !== values[3])
        return { rowCount: 0, rows: [] };
      rows.set(values[2], JSON.parse(values[0]));
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith("INSERT INTO mcp_url_clients"))
      clients.set(values[0], JSON.parse(values[1]));
    if (sql.startsWith("SELECT state FROM mcp_url_clients"))
      return {
        rows: clients.has(values[0])
          ? [{ state: structuredClone(clients.get(values[0])) }]
          : [],
      };
    return { rows: [], rowCount: 1 };
  };
  const db = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as Pick<typeof pool, "query" | "connect">;
  const a = new McpUrlElicitation(
    postgresUrlElicitationStore(db),
    () => secret,
  );
  const owner = a.ownerHash(fakeRequest(proof()));
  const row = await a.create("agpl_waiver_checkout", owner);
  assert.equal(queries.at(-1), "COMMIT");
  const b = new McpUrlElicitation(
    postgresUrlElicitationStore(db),
    () => secret,
  );
  assert.deepEqual(await b.getHandoffStatus(row.elicitationId, owner), row);
  await a.rememberClient(owner, capable, legacy);
  assert.equal(await b.supportsRememberedClient(owner, legacy), true);
  const reference = "waiver:" + randomUUID();
  await b.bindReference(row.elicitationId, owner, reference);
  await a.markHandoffCompleted(row.elicitationId, owner, reference);
  assert.equal(
    (await b.getHandoffStatus(row.elicitationId, owner)).status,
    "completed",
  );
  assert.ok(queries.some((sql) => sql.includes("revision=$5")));
  assert.equal(JSON.stringify([...rows.values()]).includes(ownerKey), false);
});
