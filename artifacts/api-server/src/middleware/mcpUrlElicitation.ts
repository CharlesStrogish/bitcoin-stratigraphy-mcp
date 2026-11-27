import type { RequestHandler } from "express";
import {
  InitializeRequestSchema,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_META,
  statelessMcpResult,
  type McpProtocolContext,
} from "../lib/mcp-stateless";
import {
  McpUrlElicitation,
  UrlHandoffError,
  URL_HANDOFF_METHOD,
  URL_HANDOFF_STATUS,
  checkoutIntent,
  clientSupportsUrlElicitation,
} from "../lib/mcp-url-elicitation";

/** Non-tool extension. Ordinary calls never enter this path or lose their toll. */
export function mcpUrlElicitation(service: McpUrlElicitation): RequestHandler {
  return async (req, res, next) => {
    if (req.path !== "/mcp" || req.method !== "POST" || Array.isArray(req.body))
      return next();
    const body = req.body as Record<string, any> | undefined;
    if (!body) return next();
    const context = res.locals.mcpProtocol as McpProtocolContext | undefined;
    const isModern = context?.era === "stateless";
    if (body.method === "initialize") {
      if (
        !InitializeRequestSchema.safeParse(body).success ||
        body.params?.protocolVersion !== "2025-11-25" ||
        !clientSupportsUrlElicitation(body.params?.capabilities)
      )
        return next();
      // Finite transports retain capability consent by a cryptographic owner,
      // never by Mcp-Session-Id. Unmodified clients perform no new storage work.
      if (
        !req.get("X-MCP-Owner-Key") &&
        !req.get("X-Nostr-Authorization") &&
        !req.get("Authorization")?.startsWith("Nostr ")
      )
        return next();
      try {
        const owner = service.ownerHash(req);
        await service.rememberClient(
          owner,
          body.params?.capabilities,
          body.params?.protocolVersion,
        );
      } catch (error) {
        if (!(error instanceof UrlHandoffError)) {
          res.status(503).json({
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: -32603,
              message: "Checkout capability storage unavailable",
            },
          });
          return;
        }
        // Initialize remains unchanged; invalid ownership cannot register consent.
      }
      return next();
    }
    if (body.method !== URL_HANDOFF_METHOD) return next();
    res.setHeader("Cache-Control", "no-store");
    const fail = (status: number, code: number, message: string) => {
      res.status(status).json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code, message },
      });
    };
    try {
      const meta = body.params?._meta;
      const capabilities = isModern
        ? context.clientCapabilities
        : meta?.[MCP_META.clientCapabilities];
      // If a caller explicitly supplies capabilities, absence of url is a denial,
      // not permission to resurrect previously remembered consent.
      if (
        capabilities !== undefined &&
        !clientSupportsUrlElicitation(capabilities)
      ) {
        fail(404, -32601, "Method not found");
        return;
      }
      const owner = service.ownerHash(req);
      const version = isModern
        ? context.protocolVersion
        : (meta?.[MCP_META.protocolVersion] ?? req.get("MCP-Protocol-Version"));
      if (version !== "2025-11-25" && version !== "2026-07-28") {
        fail(404, -32601, "Method not found");
        return;
      }
      const supported =
        capabilities === undefined
          ? await service.supportsRememberedClient(owner, version)
          : clientSupportsUrlElicitation(capabilities);
      if (!supported) {
        fail(404, -32601, "Method not found");
        return;
      }
      const params = body.params;
      if (
        !params ||
        !checkoutIntent(params.intent) ||
        Object.keys(params).some(
          (key) => !["intent", "requestState", "_meta"].includes(key),
        ) ||
        (params.requestState !== undefined &&
          typeof params.requestState !== "string")
      ) {
        fail(
          400,
          -32602,
          "Provide a checkout intent and optional opaque requestState",
        );
        return;
      }
      const row =
        params.requestState === undefined
          ? await service.create(params.intent, owner)
          : await service.getHandoffStatus(params.requestState, owner);
      if (row.intent !== params.intent) {
        fail(403, 403, "Checkout intent mismatch");
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      const completion = {
        completion_strategy: "poll_and_retry",
        status_endpoint: URL_HANDOFF_STATUS + "/" + row.elicitationId,
        poll_interval_ms: 5000,
        expires_at: row.expiresAt,
        retry: {
          method: "POST",
          path: "/mcp",
          jsonrpc_method: URL_HANDOFF_METHOD,
          params: { intent: row.intent, requestState: row.elicitationId },
        },
        ownership:
          "Send the same X-MCP-Owner-Key or fresh request-bound NIP-98 on every poll and retry; requestState and elicitationId confer no access.",
        payment_scope:
          "Completion is checkout correlation only; it never authorizes paid MCP tools or delivers payment credentials.",
      };
      const reply = (result: Record<string, unknown>) =>
        res.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: isModern
            ? statelessMcpResult(URL_HANDOFF_METHOD, result)
            : result,
        });
      if (row.status === "completed") {
        reply({
          resultType: "complete",
          ...service.publicStatus(row),
          ...completion,
        });
      } else if (isModern) {
        reply({
          resultType: "input_required",
          requestState: row.elicitationId,
          inputRequests: {
            [row.elicitationId]: {
              method: "elicitation/create",
              params: service.elicitation(row),
            },
          },
          ...completion,
        });
      } else {
        const error = new UrlElicitationRequiredError([
          service.elicitation(row),
        ]);
        res.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: error.code,
            message: error.message,
            data: { ...(error.data as object), ...completion },
          },
        });
      }
    } catch (error) {
      if (!(error instanceof UrlHandoffError))
        req.log?.error("Checkout handoff storage unavailable");
      fail(
        error instanceof UrlHandoffError ? error.status : 503,
        error instanceof UrlHandoffError ? error.status : -32603,
        error instanceof UrlHandoffError
          ? error.message
          : "Checkout handoff unavailable",
      );
    }
  };
}
