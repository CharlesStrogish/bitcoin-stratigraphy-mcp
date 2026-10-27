import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { pool } from "@workspace/db";
import {
  registerMcpRoute,
  mcpToolDefinitions,
  indexedContractTestFixture,
} from "../../src/routes/mcp";
import { registerToolIntegrityRoute } from "../../src/routes/tool-integrity";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import {
  EnterpriseCreditTabs,
  CREDIT_TAB_PATH,
} from "../../src/lib/enterprise-credit-tabs";
import { EnterpriseEconomics } from "../../src/lib/enterprise-economics";
import { createMemoryEnterpriseEconomicsStore } from "../../src/lib/enterprise-economics-store";
import { createEnterpriseEconomicsMiddleware } from "../../src/middleware/enterprise-economics";
import { createMemoryRevenueLedger } from "../../src/services/ledger";
import type { SettlementRouter } from "../../src/services/settlement";

export const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const tabPath = CREDIT_TAB_PATH;
export const identity = () => {
  const key = generateSecretKey();
  return { key, pubkey: getPublicKey(key) };
};
export type Identity = ReturnType<typeof identity>;
export function rpc(
  method = "tools/call",
  params: Record<string, unknown> = { name: "mesh.get_status", arguments: {} },
) {
  return {
    jsonrpc: "2.0",
    id: randomUUID(),
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "credit-regression",
          version: "1",
        },
      },
    },
  };
}
export function solve(challenge: string) {
  let nonce = 0;
  while (!sha(`${challenge}:${nonce}`).startsWith("000")) nonce++;
  return {
    "X-L402-PoW-Challenge": challenge,
    "X-L402-PoW-Nonce": String(nonce),
  };
}
export function createCreditHarness() {
  const invoices = new Map<
    string,
    { preimage: string; amount: number; description: string; paid: boolean }
  >();
  const economicStore = createMemoryEnterpriseEconomicsStore();
  const key = generateKeyPairSync("ed25519").privateKey;
  const economics = new EnterpriseEconomics(
    economicStore,
    async () => null,
    () => key,
  );
  const ledger = createMemoryRevenueLedger();
  let clock = Date.now();
  const tabs = new EnterpriseCreditTabs(undefined, () => clock);
  const servers: Server[] = [];
  const identities = new Set<string>();
  let unavailable = false;
  let failInvoice = false;
  let completions = 0;
  let executions = 0;
  const router: SettlementRouter = economics.wrap({
    isConfigured: () => true,
    activeProvider: () => "credit-test",
    circuitState: () => "closed",
    async createInvoice(input) {
      if (failInvoice) throw new Error("wallet offline");
      const preimage = sha(randomUUID());
      const paymentHash = sha(Buffer.from(preimage, "hex"));
      invoices.set(paymentHash, {
        preimage,
        amount: input.amountMsats,
        description: input.description,
        paid: false,
      });
      return {
        invoice: "lnbccredittest",
        paymentHash,
        provider: "credit-test",
      };
    },
    async verifyPayment(input) {
      if (unavailable) return "unavailable";
      const invoice = invoices.get(input.paymentHash);
      if (
        !invoice?.paid ||
        invoice.amount !== input.expectedAmountMsats ||
        invoice.description !== input.expectedDescription ||
        input.expectedProvider !== "credit-test" ||
        input.asset !== "btc-lightning" ||
        (input.verificationMode !== "merchant-lookup" &&
          invoice.preimage !== input.preimage)
      )
        return "invalid";
      return {
        provider: "credit-test",
        settledAt: Date.now(),
        asset: "btc-lightning",
      };
    },
  });
  async function worker(
    creditTabs = new EnterpriseCreditTabs(undefined, () => clock),
    backend = indexedContractTestFixture,
  ) {
    const app = express();
    const journals = new Map<string, Record<string, unknown>>();
    app.use(
      express.json({
        verify(req, _res, buffer) {
          (req as express.Request & { rawBody?: Buffer }).rawBody =
            Buffer.from(buffer);
        },
      }),
    );
    app.use(createEnterpriseEconomicsMiddleware(economics));
    registerMcpRoute(app, {
      creditTabs,
      settlementRouter: router,
      sessionSecret: "enterprise-credit-tests",
      ledger,
      x402ResourceServer: null,
      revocationStore: createMemoryMacaroonRevocationStore(),
      stratigraphyBackend: backend,
      onPaidToolCompleted: () => {
        completions++;
      },
      pipelineReceiptStore: {
        ready: async () => {},
        async reserve(id, value) {
          if (journals.has(id)) return false;
          journals.set(id, value);
          return true;
        },
        async save(id, value) {
          journals.set(id, value);
        },
      },
    });
    registerToolIntegrityRoute(app, mcpToolDefinitions, key);
    const sign = app.locals.signMcpToolResponse;
    app.locals.signMcpToolResponse = (name: string, result: unknown) => {
      executions++;
      return sign(name, result);
    };
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  function signed(
    base: string,
    path: string,
    body: unknown,
    agent: Identity,
    method = "POST",
  ) {
    identities.add(agent.pubkey);
    const url = process.env.NIP98_PUBLIC_ORIGIN
      ? new URL(path, process.env.NIP98_PUBLIC_ORIGIN).href
      : base + path;
    const event = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", url],
          ["method", method],
          ["nonce", randomUUID()],
          ...(body === undefined
            ? []
            : [["payload", sha(JSON.stringify(body))]]),
        ],
      },
      agent.key,
    );
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  }
  async function request(
    base: string,
    body: unknown,
    agent?: Identity,
    options: {
      path?: string;
      auth?: string;
      headers?: Record<string, string>;
      signed?: string;
      method?: string;
    } = {},
  ) {
    const path = options.path ?? "/mcp";
    const method = options.method ?? "POST";
    const proof =
      options.signed ??
      (agent ? signed(base, path, body, agent, method) : undefined);
    const message = body as ReturnType<typeof rpc> | undefined;
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(path === "/mcp" || path === "/invoice/request"
          ? {
              "MCP-Protocol-Version": "2026-07-28",
              "Mcp-Method": message!.method,
              ...(message!.params.name
                ? { "Mcp-Name": String(message!.params.name) }
                : {}),
            }
          : {}),
        ...(proof
          ? options.auth
            ? { "X-Nostr-Authorization": proof }
            : { Authorization: proof }
          : {}),
        ...(options.auth ? { Authorization: options.auth } : {}),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await response.json();
    return {
      status: response.status,
      body: parsed,
      data: parsed.error?.data ?? parsed,
      headers: response.headers,
    };
  }
  async function seed(agent: Identity, count: number) {
    identities.add(agent.pubkey);
    for (let i = 0; i < count; i++)
      await tabs.recordPaid(
        agent.pubkey,
        "credit-test",
        sha(randomUUID()),
        250,
      );
  }
  async function cleanup() {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    const keys = [...identities];
    await pool.query(
      "DELETE FROM enterprise_credit_fleet WHERE commander_pubkey=ANY($1::text[])",
      [keys],
    );
    await pool.query(
      "DELETE FROM enterprise_credit_fleet_updates WHERE commander_pubkey=ANY($1::text[])",
      [keys],
    );
    await pool.query(
      "DELETE FROM enterprise_credit_charges WHERE pubkey=ANY($1::text[])",
      [keys],
    );
    await pool.query(
      "DELETE FROM enterprise_credit_settlements WHERE pubkey=ANY($1::text[])",
      [keys],
    );
    await pool.query(
      "DELETE FROM enterprise_credit_accounts WHERE pubkey=ANY($1::text[])",
      [keys],
    );
  }
  return {
    tabs,
    router,
    ledger,
    economicStore,
    invoices,
    worker,
    signed,
    request,
    seed,
    cleanup,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    failInvoice: (value: boolean) => {
      failInvoice = value;
    },
    completions: () => completions,
    executions: () => executions,
  };
}
