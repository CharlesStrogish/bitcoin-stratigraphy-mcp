// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { BitcoinStratigraphyRouter } from "../../../agentic-fiduciary-router/index.js";
import { withInvoicePow } from "../../typescript/invoice-pow.js";
import { readRpc } from "./protocol.js";
import { terminalReceipt } from "./terminal-receipts.js";
import { SpendCircuit, TruthReceipt, type PaymentEvidence } from "./armor.js";
import { verifyPayload } from "./provenance.js";
export { FiduciaryTamperingError } from "./provenance.js";
export { CircuitBreakerError, TruthReceipt } from "./armor.js";

export const DEFAULT_MCP_URL = "https://bitcoinstratigraphy.com/mcp";

export interface YieldWallet {
  payInvoice(invoice: string): Promise<{ preimage: string; fees_paid?: number }>;
  /** Required only for automatic yield withdrawal, not paid tool execution. */
  makeInvoice?(amountMsats: number): Promise<{ invoice: string }>;
}
export interface FiduciaryOptions {
  /** Independently trusted Ed25519 public key, SPKI PEM. Required for tool results. */
  serverPublicKey?: string;
  /** Session spend cap including reported fees / reserved fee headroom. */
  max_spend_sats?: number;
  wallet?: YieldWallet;
  nwcUri?: string;
  maxPaymentSats: number;
  maxTotalSats: number;
  feeReserveSats?: number;
  stateDirectory?: string;
  timeoutMs?: number;
  mcpUrl?: string;
  fetch?: typeof fetch;
  identityHeaders?: (url: string, method: string, body: Uint8Array) =>
    Promise<HeadersInit>;
  onYieldClaim?: (event: { status: string; claimId?: string; amountMsats: string }) => void;
  onError?: (event: { code: string }) => void;
}
export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface AgentTool extends DiscoveredTool {
  invoke(args?: Record<string, unknown>): Promise<TruthReceipt>;
}
export interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface FiduciaryConnection {
  fetch: typeof fetch;
  tools: AgentTool[];
  openAITools: OpenAITool[];
  callTool(name: string, args?: Record<string, unknown>): Promise<TruthReceipt>;
  executeTool(name: string, args?: Record<string, unknown>): Promise<TruthReceipt>;
  drain(): Promise<void>;
  recoverClaim(paymentHash: string): Promise<void>;
}
interface RouterCore {
  paymentReceipt(response: Response): PaymentEvidence | null;
  fetch: typeof fetch;
  drain(): Promise<void>;
  recoverClaim(paymentHash: string): Promise<void>;
}
// The JS router is the single source of payment truth. tsc includes it and its
// local dependencies in dist, making the packed SDK independent of this repo.
const Router = BitcoinStratigraphyRouter as unknown as new (
  options: FiduciaryOptions & {
    allowedOrigins: string[];
    onYieldAllocation: (event: { amountMsats: string }) => void;
    circuitBreaker: SpendCircuit;
  },
) => RouterCore;

export class FiduciaryClient {
  readonly fetch: typeof fetch;
  private readonly router: RouterCore;
  private readonly discoveryFetch: typeof fetch;
  private readonly url: string;
  private readonly timeout: number;
  private readonly identity: NonNullable<FiduciaryOptions["identityHeaders"]>;
  private nextId = 0;
  private catalog?: Promise<DiscoveredTool[]>;
  private readonly receipts = new WeakMap<object, PaymentEvidence | null>();
  private readonly circuit: SpendCircuit;
  private readonly serverPublicKey?: string;

  constructor(options: FiduciaryOptions) {
    this.serverPublicKey = options.serverPublicKey;
    this.circuit = new SpendCircuit(options.max_spend_sats ?? 5000);
    const url = new URL(options.mcpUrl ?? DEFAULT_MCP_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error("HTTPS_MCP_URL_REQUIRED");
    }
    this.url = url.href;
    this.timeout = options.timeoutMs ?? 65_000;
    this.identity = options.identityHeaders ?? (async () => ({}));
    const nativeFetch = options.fetch ?? globalThis.fetch;
    const admission = withInvoicePow(
      async (input, init) => nativeFetch(input, init),
      input => createHash("sha256").update(input).digest("hex"),
    );
    // Normalize Request objects before the shared admission solver, which
    // preserves the exact body, signal and headers for its one bounded retry.
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!request.headers.get("content-type")?.includes("application/json")) {
        return nativeFetch(request);
      }
      return admission(request.url, {
        method: request.method, headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
        signal: request.signal, redirect: "error",
      });
    };
    this.discoveryFetch = (input, init) => transport(input, {
      ...init, signal: AbortSignal.timeout(this.timeout),
    });
    this.router = new Router({
      ...options,
      circuitBreaker: this.circuit,
      nwcUri: options.nwcUri ?? (options.wallet ? undefined : process.env.NWC_URI),
      stateDirectory: options.stateDirectory ?? resolve(".agent-yield-state"),
      allowedOrigins: [url.origin],
      fetch: transport,
      onYieldAllocation: event => terminalReceipt("allocated", event.amountMsats, this.circuit.remainingMsats.toString()),
      onYieldClaim: event => {
        if (event.status === "settled") terminalReceipt("settled", event.amountMsats, this.circuit.remainingMsats.toString());
        return options.onYieldClaim?.(event);
      },
    });
    this.fetch = async (input, init) => {
      const request = new Request(input, init);
      // Bound discovery, HTTP/SSE reads and wallet-independent requests too.
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.timeout)]);
      return this.router.fetch(new Request(request, { signal }));
    };
  }

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.nextId;
    const body = JSON.stringify({
      jsonrpc: "2.0", id, method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const headers = new Headers(await this.identity(this.url, "POST", Buffer.from(body)));
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    headers.set("MCP-Protocol-Version", "2026-07-28");
    headers.set("Mcp-Method", method);
    if (method === "tools/call") headers.set("Mcp-Name", String(params.name));
    // tools/list is public discovery. Never let an unexpected discovery 402
    // charge a wallet before the agent has selected a tool.
    const fetcher = method === "tools/list" ? this.discoveryFetch : this.fetch;
    const response = await fetcher(this.url, { method: "POST", headers, body });
    const result = await readRpc(response, id, method === "tools/call"
      ? bytes => verifyPayload(bytes, response.headers.get("X-Stratigraphy-Signature"), body, this.serverPublicKey)
      : undefined);
    if (result && typeof result === "object") {
      this.receipts.set(result, this.router.paymentReceipt(response));
    }
    return result;
  }

  listTools(): Promise<DiscoveredTool[]> {
    this.catalog ??= this.discover().catch(error => {
      this.catalog = undefined;
      throw error;
    });
    return this.catalog;
  }

  private async discover(): Promise<DiscoveredTool[]> {
    const tools: DiscoveredTool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc("tools/list", cursor ? { cursor } : {}) as {
        tools?: DiscoveredTool[]; nextCursor?: string;
      };
      if (!page || !Array.isArray(page.tools)) throw new Error("MCP_INVALID_CATALOG");
      for (const tool of page.tools) {
        if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) ||
            !tool.inputSchema || typeof tool.inputSchema !== "object" ||
            Array.isArray(tool.inputSchema) ||
            (tool.description !== undefined && typeof tool.description !== "string") ||
            tools.some(item => item.name === tool.name)) throw new Error("MCP_INVALID_TOOL");
        tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined &&
          (typeof cursor !== "string" || !cursor || cursors.has(cursor) || cursors.size >= 100)) {
        throw new Error("MCP_INVALID_CURSOR");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<TruthReceipt> {
    this.circuit.assertCapacity();
    if (!(await this.listTools()).some(tool => tool.name === name)) throw new Error("MCP_UNKNOWN_TOOL");
    const result = await this.rpc("tools/call", { name, arguments: args }) as {
      isError?: boolean; structuredContent?: unknown; content?: unknown[];
    };
    if (!result || typeof result !== "object") throw new Error("MCP_INVALID_TOOL_RESULT");
    if (result.isError) throw new Error("MCP_TOOL_FAILED");
    // Text-only tools are legitimate too; do not require structuredContent.
    return new TruthReceipt(result.structuredContent ?? result.content ?? result, this.receipts.get(result), true);
  }

  drain(): Promise<void> { return this.router.drain(); }
  recoverClaim(paymentHash: string): Promise<void> { return this.router.recoverClaim(paymentHash); }
}

export type AgentConfig = {
  fiduciary: FiduciaryOptions;
  tools?: unknown[];
  framework?: "custom" | "langchain" | "openai";
  [key: string]: unknown;
};

/**
 * Preserves the user's configuration and existing tools. Never monkeypatches
 * global fetch or mutates an already-running framework's private internals.
 */
export async function withFiduciaryYield<T extends AgentConfig>(
  config: T,
): Promise<Omit<T, "fiduciary" | "tools"> & {
  tools: unknown[];
  fetch: typeof fetch;
  fiduciary: FiduciaryConnection;
}> {
  const { fiduciary: options, tools: existing = [], ...rest } = config;
  const client = new FiduciaryClient(options);
  const catalog = await client.listTools();
  const tools: AgentTool[] = catalog.map(tool => ({
    ...tool, invoke: args => client.callTool(tool.name, args),
  }));
  // OpenAI/AutoGen function names cannot contain dots. Keep a lossless mapping.
  const aliases = new Map(catalog.map((tool, index) => [
    `fiduciary_${index}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64),
    tool.name,
  ]));
  const openAITools: OpenAITool[] = [...aliases].map(([name, canonical], index) => ({
    type: "function",
    function: {
      name, description: catalog[index].description ?? canonical,
      parameters: catalog[index].inputSchema,
    },
  }));
  let adapted: unknown[] = tools;
  if (config.framework === "openai") adapted = openAITools;
  if (config.framework === "langchain") {
    // Optional runtime peer: custom/OpenAI users need no framework dependency.
    const moduleName = "@langchain/core/tools";
    const { tool } = await import(moduleName).catch(() => {
      throw new Error("INSTALL_LANGCHAIN_CORE_FOR_LANGCHAIN_ADAPTER");
    });
    adapted = tools.map((item, index) => tool(
      (args: Record<string, unknown>) => item.invoke(args),
      {
        name: openAITools[index].function.name,
        description: item.description ?? item.name, schema: item.inputSchema,
      },
    ));
  }
  return {
    ...rest, tools: [...existing, ...adapted], fetch: client.fetch,
    fiduciary: {
      fetch: client.fetch, tools, openAITools,
      callTool: (name, args) => client.callTool(name, args),
      executeTool: (name, args) => {
        const canonical = aliases.get(name);
        if (!canonical) return Promise.reject(new Error("MCP_UNKNOWN_TOOL"));
        return client.callTool(canonical, args);
      },
      drain: () => client.drain(),
      recoverClaim: hash => client.recoverClaim(hash),
    },
  };
}
