import type { RequestHandler } from "express";

function responseId(body: unknown): string | number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? id : null;
}

/** Preserve L402/x402 challenge fields while framing every HTTP failure as JSON-RPC. */
export const frameMcpErrors: RequestHandler = (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 400) return json(body);
    const payload = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
    const existing = payload.error;
    if (payload.jsonrpc === "2.0" && existing && typeof existing === "object" &&
      typeof (existing as { code?: unknown }).code === "number" &&
      typeof (existing as { message?: unknown }).message === "string") {
      return json({ ...payload, id: responseId(payload) ?? responseId(req.body) });
    }
    const message = typeof existing === "string" ? existing
      : typeof payload.message === "string" ? payload.message
      : res.statusCode === 402 ? "Payment required" : "MCP request failed";
    const code = res.statusCode >= 500 ? -32603
      : res.statusCode === 400 ? -32600
      : res.statusCode === 402 ? -32002
      : res.statusCode === 429 ? -32029 : -32001;
    return json({
      ...payload,
      jsonrpc: "2.0",
      error: { code, message },
      id: responseId(req.body),
    });
  };
  next();
};

/** Reject malformed request envelopes before tool side effects or payment issuance. */
export const validateMcpEnvelope: RequestHandler = (req, res, next) => {
  if (req.method !== "POST") return next();
  const valid = (body: unknown): boolean => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const value = body as Record<string, unknown>;
    return value.jsonrpc === "2.0" && typeof value.method === "string" &&
      (!Object.hasOwn(value, "id") || value.id === null ||
        typeof value.id === "string" || (typeof value.id === "number" && Number.isFinite(value.id))) &&
      (!Object.hasOwn(value, "params") || (value.params !== null && typeof value.params === "object"));
  };
  const body = req.body;
  const validBody = Array.isArray(body)
    ? body.length > 0 && body.every(valid) : valid(body);
  if (!validBody) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request" },
      id: responseId(body),
    });
    return;
  }
  next();
};