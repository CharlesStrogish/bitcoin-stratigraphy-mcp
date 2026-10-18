// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Request, RequestHandler, Response } from "express";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCErrorResponse,
  type JSONRPCRequest,
  type JSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { ENGINE_DESCRIPTION } from "./engine-metadata";
import { RELEASE_VERSION } from "./public-site";

/**
 * MCP 2026-07-28 stateless Streamable HTTP, served in front of the SDK's
 * handshake-era handlers. A request that carries its protocol version and
 * client capabilities in `params._meta` is answered on its own (SEP-2575),
 * with no initialize handshake and no Mcp-Session-Id (SEP-2567). Requests
 * without per-request metadata keep the legacy initialize flow. Neither era
 * mints or stores a session, so any instance can answer any request.
 */
export const STATELESS_MCP_PROTOCOL_VERSION = "2026-07-28";

/** Handshake-era revisions still served through the SDK initialize flow. */
export const LEGACY_MCP_PROTOCOL_VERSIONS: readonly string[] =
  SUPPORTED_PROTOCOL_VERSIONS.filter(
    (version) => version !== STATELESS_MCP_PROTOCOL_VERSION,
  );

/** Newest first, as advertised by server/discover and version errors. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  STATELESS_MCP_PROTOCOL_VERSION,
  ...LEGACY_MCP_PROTOCOL_VERSIONS,
];

export const MCP_META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  logLevel: "io.modelcontextprotocol/logLevel",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

/** Error codes defined by 2026-07-28 for header and version negotiation. */
export const MCP_HEADER_MISMATCH = -32020;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export const MCP_SERVER_INFO = {
  name: "bitcoin-stratigraphy",
  version: RELEASE_VERSION,
} as const;

/** A fresh object per call: the SDK merges capabilities in place. */
export function mcpServerCapabilities() {
  return { prompts: {}, resources: {}, tools: {} };
}

/**
 * Methods answered under 2026-07-28. Everything else, including the removed
 * initialize and ping methods, is HTTP 404 with JSON-RPC -32601.
 */
export const STATELESS_MCP_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "tools/call",
  "resources/list",
  "prompts/list",
]);

/**
 * CacheableResult methods (SEP-2549). These results are identical for every
 * caller of a release, so shared intermediaries may cache them.
 */
const CACHEABLE_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "resources/list",
  "prompts/list",
]);
export const MCP_CACHE_TTL_MS = 300_000;

/** Body field mirrored by the Mcp-Name header (SEP-2243). */
const MCP_NAME_SOURCES: ReadonlyMap<string, "name" | "uri"> = new Map([
  ["tools/call", "name"],
  ["prompts/get", "name"],
  ["resources/read", "uri"],
]);

const LOG_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);

/** Codes a 2026-07-28 client may receive from the reserved JSON-RPC range. */
const STATELESS_RESERVED_CODES: ReadonlySet<number> = new Set([
  ErrorCode.ParseError,
  ErrorCode.InvalidRequest,
  ErrorCode.MethodNotFound,
  ErrorCode.InvalidParams,
  ErrorCode.InternalError,
  MCP_HEADER_MISMATCH,
  -32021,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
]);

export type StatelessMcpContext = {
  era: "stateless";
  protocolVersion: string;
  method: string;
  id: string | number;
  clientCapabilities: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
};

export type McpProtocolContext = StatelessMcpContext | { era: "legacy" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRequestId = (id: unknown): id is string | number =>
  typeof id === "string" ||
  (typeof id === "number" && Number.isSafeInteger(id));

const isLegacyVersion = (version: unknown): boolean =>
  typeof version === "string" && LEGACY_MCP_PROTOCOL_VERSIONS.includes(version);

const clip = (value: string): string =>
  value.length > 120 ? `${value.slice(0, 117)}...` : value;

function metaOf(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message) || !isRecord(message.params)) return undefined;
  return isRecord(message.params._meta) ? message.params._meta : undefined;
}

function protocolHeader(req: Request): string | undefined {
  const value = req.header("MCP-Protocol-Version")?.trim();
  return value ? value : undefined;
}

/**
 * Whether a response belongs to the stateless era: negotiated as such, or
 * (for failures before negotiation, such as rate limits) a request that opts
 * into per-request versioning with 2026-07-28 or an unknown newer revision.
 */
export function isStatelessMcpExchange(req: Request, res: Response): boolean {
  const negotiated = res.locals.mcpProtocol as McpProtocolContext | undefined;
  if (negotiated) return negotiated.era === "stateless";
  const header = protocolHeader(req);
  if (header !== undefined && !isLegacyVersion(header)) return true;
  const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
  return messages.some((message) => {
    if (isRecord(message) && message.method === "server/discover") return true;
    const version = metaOf(message)?.[MCP_META.protocolVersion];
    return version !== undefined && !isLegacyVersion(version);
  });
}

/**
 * Remaps codes that 2026-07-28 forbids (the legacy -32000..-32019 range and
 * undefined reserved codes) to the HTTP status or a standard JSON-RPC code.
 */
export function statelessErrorCode(code: number, httpStatus: number): number {
  if (STATELESS_RESERVED_CODES.has(code)) return code;
  if (code < -32768 || code > -32000) return code;
  return statelessFailureCode(httpStatus);
}

/** Code for an HTTP failure body that was not already JSON-RPC framed. */
export function statelessFailureCode(httpStatus: number): number {
  if (httpStatus >= 500 || httpStatus < 400) return ErrorCode.InternalError;
  return httpStatus === 400 ? ErrorCode.InvalidRequest : httpStatus;
}

const HEADER_VALUE = /^[\x20-\x7E\t]*$/;
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Decodes an SEP-2243 header value. Mcp-Name may use the case-sensitive
 * `=?base64?...?=` sentinel for non-ASCII or padded values. Returns null for
 * invalid characters or a malformed sentinel.
 */
export function decodeMcpHeaderValue(
  value: string,
  allowBase64: boolean,
): string | null {
  if (!HEADER_VALUE.test(value)) return null;
  if (!allowBase64 || !value.startsWith("=?base64?") || !value.endsWith("?=")) {
    return value;
  }
  const encoded = BASE64_SENTINEL.exec(value)?.[1];
  if (encoded === undefined || encoded.length % 4 !== 0) return null;
  try {
    return strictUtf8.decode(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

/**
 * Mcp-Method and Mcp-Name let load balancers route without parsing bodies,
 * so they must agree with the body. Stateless requests must send them;
 * handshake-era requests are checked only when they include them.
 */
function routingHeaderMismatch(
  req: Request,
  message: Record<string, unknown>,
  required: boolean,
): string | undefined {
  const method = String(message.method);
  const methodHeader = req.header("Mcp-Method");
  if (methodHeader === undefined) {
    if (required) {
      return "Header mismatch: the Mcp-Method header is required and must equal the JSON-RPC method.";
    }
  } else {
    const value = decodeMcpHeaderValue(methodHeader, false);
    if (value === null) {
      return "Header mismatch: the Mcp-Method header contains invalid characters.";
    }
    if (value !== method) {
      return `Header mismatch: Mcp-Method header value '${clip(value)}' does not match body value '${clip(method)}'.`;
    }
  }
  const field = MCP_NAME_SOURCES.get(method);
  const nameHeader = req.header("Mcp-Name");
  if (nameHeader === undefined) {
    return required && field
      ? `Header mismatch: the Mcp-Name header is required for ${method} and must equal params.${field}.`
      : undefined;
  }
  if (!field) {
    return `Header mismatch: the Mcp-Name header does not apply to ${clip(method)}.`;
  }
  const value = decodeMcpHeaderValue(nameHeader, true);
  if (value === null) {
    return "Header mismatch: the Mcp-Name header is malformed or contains invalid characters.";
  }
  const params = isRecord(message.params) ? message.params : {};
  const expected = params[field];
  if (value !== expected) {
    return `Header mismatch: Mcp-Name header value '${clip(value)}' does not match body value '${clip(String(expected))}'.`;
  }
  return undefined;
}

function sendRpcError(
  res: Response,
  status: number,
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    ...(isRequestId(id) ? { id } : {}),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function unsupportedVersion(
  res: Response,
  id: unknown,
  requested: string,
): void {
  sendRpcError(
    res,
    400,
    id,
    MCP_UNSUPPORTED_PROTOCOL_VERSION,
    `Unsupported protocol version: ${clip(requested)}. Supported versions: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
    { supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS], requested },
  );
}

const INITIALIZE_GUIDANCE =
  `initialize is not part of MCP ${STATELESS_MCP_PROTOCOL_VERSION}: there is no handshake or session. ` +
  `Call server/discover, then send each request with params._meta["${MCP_META.protocolVersion}"] and ` +
  `params._meta["${MCP_META.clientCapabilities}"], plus matching MCP-Protocol-Version and Mcp-Method headers. ` +
  `Handshake-era clients can still initialize by sending MCP-Protocol-Version: 2025-11-25 without _meta.`;

const MISSING_META_GUIDANCE =
  `MCP ${STATELESS_MCP_PROTOCOL_VERSION} requests must carry params._meta["${MCP_META.protocolVersion}"] ` +
  `and params._meta["${MCP_META.clientCapabilities}"] on every request; there is no initialize handshake.`;

/**
 * Selects the protocol era for one POST before any payment or tool work, and
 * validates 2026-07-28 metadata and headers. It never mutates req.body, whose
 * exact bytes NIP-98 signatures cover.
 */
export const negotiateMcpProtocol: RequestHandler = (req, res, next) => {
  if (req.method !== "POST") return next();
  const header = protocolHeader(req);
  const body: unknown = req.body;
  if (Array.isArray(body)) {
    if (!isStatelessMcpExchange(req, res)) {
      res.locals.mcpProtocol = { era: "legacy" } satisfies McpProtocolContext;
      return next();
    }
    if (
      header !== undefined &&
      !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(header)
    ) {
      return unsupportedVersion(res, undefined, header);
    }
    return sendRpcError(
      res,
      400,
      undefined,
      ErrorCode.InvalidRequest,
      `MCP ${STATELESS_MCP_PROTOCOL_VERSION} does not accept JSON-RPC batches; send one request per HTTP POST.`,
    );
  }
  if (!isRecord(body)) return next();
  const method = String(body.method);
  const meta = metaOf(body);
  const metaVersion = meta?.[MCP_META.protocolVersion];
  const perRequest =
    method === "server/discover" ||
    metaVersion !== undefined ||
    (header !== undefined && !isLegacyVersion(header));
  if (perRequest) {
    if (
      header !== undefined &&
      !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(header)
    ) {
      return unsupportedVersion(res, body.id, header);
    }
    if (metaVersion !== undefined) {
      if (typeof metaVersion !== "string" || metaVersion.length === 0) {
        return sendRpcError(
          res,
          400,
          body.id,
          ErrorCode.InvalidParams,
          `params._meta["${MCP_META.protocolVersion}"] must be a protocol version string.`,
        );
      }
      if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(metaVersion)) {
        return unsupportedVersion(res, body.id, metaVersion);
      }
      if (header !== metaVersion) {
        return sendRpcError(
          res,
          400,
          body.id,
          MCP_HEADER_MISMATCH,
          header === undefined
            ? `Header mismatch: the MCP-Protocol-Version header is required and must equal params._meta["${MCP_META.protocolVersion}"] (${metaVersion}).`
            : `Header mismatch: MCP-Protocol-Version header value '${clip(header)}' does not match body value '${metaVersion}'.`,
        );
      }
    }
  }
  // Handshake-era traffic, including dual-era clients that selected a legacy
  // revision in _meta, keeps the SDK's initialize semantics.
  if (
    !perRequest ||
    (isLegacyVersion(metaVersion) && method !== "server/discover")
  ) {
    const mismatch = routingHeaderMismatch(req, body, false);
    if (mismatch) {
      return sendRpcError(res, 400, body.id, MCP_HEADER_MISMATCH, mismatch);
    }
    res.locals.mcpProtocol = { era: "legacy" } satisfies McpProtocolContext;
    return next();
  }
  if (!Object.hasOwn(body, "id")) {
    // No client notification is processed over stateless HTTP.
    res.status(202).end();
    return;
  }
  const id = body.id;
  if (!isRequestId(id)) {
    return sendRpcError(
      res,
      400,
      undefined,
      ErrorCode.InvalidRequest,
      `MCP ${STATELESS_MCP_PROTOCOL_VERSION} request ids must be strings or integers.`,
    );
  }
  if (method === "initialize") {
    return sendRpcError(
      res,
      404,
      id,
      ErrorCode.MethodNotFound,
      INITIALIZE_GUIDANCE,
      {
        supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
      },
    );
  }
  if (meta === undefined || typeof metaVersion !== "string") {
    return sendRpcError(
      res,
      400,
      id,
      ErrorCode.InvalidParams,
      MISSING_META_GUIDANCE,
    );
  }
  const clientCapabilities = meta[MCP_META.clientCapabilities];
  if (!isRecord(clientCapabilities)) {
    return sendRpcError(
      res,
      400,
      id,
      ErrorCode.InvalidParams,
      `params._meta["${MCP_META.clientCapabilities}"] must be an object; send {} when the client offers no optional capabilities.`,
    );
  }
  const clientInfo = meta[MCP_META.clientInfo];
  if (
    clientInfo !== undefined &&
    !(
      isRecord(clientInfo) &&
      typeof clientInfo.name === "string" &&
      typeof clientInfo.version === "string"
    )
  ) {
    return sendRpcError(
      res,
      400,
      id,
      ErrorCode.InvalidParams,
      `params._meta["${MCP_META.clientInfo}"] must include string name and version fields.`,
    );
  }
  const logLevel = meta[MCP_META.logLevel];
  if (
    logLevel !== undefined &&
    !(typeof logLevel === "string" && LOG_LEVELS.has(logLevel))
  ) {
    return sendRpcError(
      res,
      400,
      id,
      ErrorCode.InvalidParams,
      `params._meta["${MCP_META.logLevel}"] must be a logging level such as "info".`,
    );
  }
  const mismatch = routingHeaderMismatch(req, body, true);
  if (mismatch) {
    return sendRpcError(res, 400, id, MCP_HEADER_MISMATCH, mismatch);
  }
  if (!STATELESS_MCP_METHODS.has(method)) {
    return sendRpcError(
      res,
      404,
      id,
      ErrorCode.MethodNotFound,
      `Method not found under MCP ${STATELESS_MCP_PROTOCOL_VERSION}.`,
    );
  }
  res.locals.mcpProtocol = {
    era: "stateless",
    protocolVersion: metaVersion,
    method,
    id,
    clientCapabilities,
    ...(isRecord(clientInfo)
      ? {
          clientInfo: {
            name: String(clientInfo.name),
            version: String(clientInfo.version),
          },
        }
      : {}),
  } satisfies StatelessMcpContext;
  next();
};

/** Adds 2026-07-28 result fields without altering signed tool content. */
export function statelessMcpResult(
  method: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const meta = isRecord(result._meta) ? result._meta : {};
  return {
    ...result,
    resultType:
      typeof result.resultType === "string" ? result.resultType : "complete",
    ...(CACHEABLE_METHODS.has(method)
      ? { ttlMs: MCP_CACHE_TTL_MS, cacheScope: "public" }
      : {}),
    _meta: { ...meta, [MCP_META.serverInfo]: { ...MCP_SERVER_INFO } },
  };
}

/** server/discover: supported versions and capabilities, without a session. */
export function serverDiscoverResult(): Record<string, unknown> {
  return statelessMcpResult("server/discover", {
    supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: mcpServerCapabilities(),
    instructions: ENGINE_DESCRIPTION,
  });
}

/**
 * Answers one validated stateless request. A fresh SDK server handles it
 * over an in-memory pair, so the SDK's handshake-era HTTP transport and its
 * protocol-version header gate never see 2026-07-28 traffic.
 */
export async function answerStatelessMcpRequest(
  req: Request,
  res: Response,
  context: StatelessMcpContext,
  createServer: () => McpServer,
): Promise<void> {
  if (context.method === "server/discover") {
    res.status(200).json({
      jsonrpc: "2.0",
      id: context.id,
      result: serverDiscoverResult(),
    });
    return;
  }
  const server = createServer();
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const reply = new Promise<
    JSONRPCResultResponse | JSONRPCErrorResponse | undefined
  >((resolve) => {
    client.onmessage = (message) => {
      if (
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        message.id === context.id
      ) {
        resolve(message);
      }
    };
    client.onclose = () => resolve(undefined);
    // A disconnected caller abandons its request; closing the server below
    // aborts the handler's signal.
    res.once("close", () => resolve(undefined));
  });
  try {
    await server.connect(transport);
    await client.start();
    await client.send(req.body as JSONRPCRequest);
    const response = await reply;
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    if (response === undefined) {
      res.status(502).json({
        jsonrpc: "2.0",
        id: context.id,
        error: {
          code: ErrorCode.InternalError,
          message: "MCP server did not respond",
        },
      });
      return;
    }
    if ("error" in response) {
      const code = statelessErrorCode(response.error.code, 200);
      res.status(code === ErrorCode.MethodNotFound ? 404 : 200).json({
        jsonrpc: "2.0",
        id: context.id,
        error: { ...response.error, code },
      });
      return;
    }
    res.status(200).json({
      jsonrpc: "2.0",
      id: context.id,
      result: statelessMcpResult(context.method, response.result),
    });
  } finally {
    for (const close of [() => client.close(), () => server.close()]) {
      try {
        await close();
      } catch (error) {
        req.log?.warn({ err: error }, "MCP cleanup failed");
      }
    }
  }
}
