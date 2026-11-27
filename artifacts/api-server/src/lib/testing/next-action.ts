import assert from "node:assert/strict";
import type { Http402NextAction } from "../http402-next-action";

/** Compare only emitted values; no credentials are loaded by these assertions. */
export function assertNextAction(
  body: Record<string, any>,
  reason: Http402NextAction["reason"],
  method: string,
  path: string,
) {
  assert.deepEqual(body.next_action, {
    schema_version: "1.0",
    action: "pay_l402_invoice",
    protocol: "L402",
    reason,
    payment: {
      method: "lightning_bolt11",
      invoice: body.invoice,
      payment_hash: body.payment_hash,
      macaroon: body.macaroon,
      ...(body.amount_sats === undefined
        ? {}
        : { amount_sats: body.amount_sats }),
    },
    retry: {
      method,
      path,
      auth_header: "Authorization",
      auth_scheme: "L402",
      auth_format: "L402 <macaroon>:<preimage_hex>",
      persist_preimage_before_retry: true,
    },
    ...(body.next_action?.alternatives === undefined
      ? {}
      : {
          alternatives: [
            {
              protocol: "x402",
              action: "inspect_payment_required_header",
              header: "PAYMENT-REQUIRED",
            },
          ],
        }),
  });
}
