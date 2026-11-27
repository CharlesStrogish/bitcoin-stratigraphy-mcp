import type { Http402NextAction } from "@workspace/api-zod";
export type { Http402NextAction } from "@workspace/api-zod";

/** Challenge-local guidance only. Never reads credentials, wallets or request headers. */
export function buildHttp402NextAction(input: {
  reason: Http402NextAction["reason"];
  invoice: string;
  payment_hash: string;
  macaroon: string;
  amount_sats?: number;
  method: string;
  path: string;
}): Http402NextAction {
  return {
    schema_version: "1.0",
    action: "pay_l402_invoice",
    protocol: "L402",
    reason: input.reason,
    payment: {
      method: "lightning_bolt11",
      invoice: input.invoice,
      payment_hash: input.payment_hash,
      macaroon: input.macaroon,
      ...(input.amount_sats === undefined
        ? {}
        : { amount_sats: input.amount_sats }),
    },
    retry: {
      method: input.method,
      path: input.path,
      auth_header: "Authorization",
      auth_scheme: "L402",
      auth_format: "L402 <macaroon>:<preimage_hex>",
      persist_preimage_before_retry: true,
    },
  };
}

/** Called only after PAYMENT-REQUIRED has actually been attached to this response. */
export function withX402NextActionAlternative(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const payload = body as Record<string, unknown>;
  const action = payload.next_action as Http402NextAction | undefined;
  if (action?.schema_version === "1.0") {
    const alternatives = action.alternatives ?? [];
    if (alternatives.some((entry) => entry.protocol === "x402")) return body;
    return {
      ...payload,
      next_action: {
        ...action,
        alternatives: [
          ...alternatives,
          {
            protocol: "x402",
            action: "inspect_payment_required_header",
            header: "PAYMENT-REQUIRED",
          },
        ],
      },
    };
  }
  // Support either middleware order without adding JSON-RPC top-level keys.
  if (
    payload.jsonrpc === "2.0" &&
    payload.error &&
    typeof payload.error === "object"
  ) {
    const error = payload.error as Record<string, unknown>;
    if (error.data && typeof error.data === "object") {
      return {
        ...payload,
        error: { ...error, data: withX402NextActionAlternative(error.data) },
      };
    }
  }
  return body;
}
