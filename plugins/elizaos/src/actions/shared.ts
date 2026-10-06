import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  BitcoinStratigraphyClient,
  type WalletPayment,
} from "../../../../sdk/typescript/client.js";

type InvoicePayer = { payInvoice(invoice: string): Promise<WalletPayment> };

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The caller owns the wallet service and its spend policy. A Nostr signing key
 * alone cannot settle a Lightning invoice; never treat it as a payment proof.
 */
function walletService(runtime: IAgentRuntime): InvoicePayer | undefined {
  const service = runtime.getService("bitcoin-stratigraphy-wallet");
  return service &&
    typeof (service as unknown as InvoicePayer).payInvoice === "function"
    ? (service as unknown as InvoicePayer)
    : undefined;
}

export function hasWallet(runtime: IAgentRuntime): boolean {
  const pairing = runtime.getSetting("NWC_PAIRING_SECRET");
  return (
    walletService(runtime) !== undefined &&
    typeof pairing === "string" &&
    /^nostr\+walletconnect:\/\/\S+$/i.test(pairing)
  );
}

function clientFor(runtime: IAgentRuntime): BitcoinStratigraphyClient {
  const wallet = walletService(runtime);
  if (!wallet) {
    throw new Error(
      "A bitcoin-stratigraphy-wallet service with payInvoice(invoice) is required",
    );
  }
  if (!hasWallet(runtime)) {
    throw new Error(
      "A configured NWC_PAIRING_SECRET is required for paid actions",
    );
  }
  const setting = runtime.getSetting("BITCOIN_STRATIGRAPHY_MCP_URL");
  if (setting != null && typeof setting !== "string") {
    throw new Error("BITCOIN_STRATIGRAPHY_MCP_URL must be a URL string");
  }
  return new BitcoinStratigraphyClient(setting || undefined, (invoice) =>
    wallet.payInvoice(invoice),
  );
}

/** Explicit structured input wins over the conversational text. */
export function actionInput(
  message: Memory,
  options?: HandlerOptions,
): Record<string, unknown> {
  for (const candidate of [
    options?.input,
    message.content.input,
    message.content.parameters,
    message.content.data,
  ]) {
    const data = record(candidate);
    if (data) return data;
  }
  const text = message.content.text?.trim();
  if (text?.startsWith("{")) {
    try {
      return record(JSON.parse(text)) ?? {};
    } catch {
      return {};
    }
  }
  return record(message.content) ?? {};
}

export async function executePaidAction(
  runtime: IAgentRuntime,
  message: Memory,
  callback: HandlerCallback | undefined,
  operation: (
    client: BitcoinStratigraphyClient,
  ) => Promise<Record<string, unknown>>,
  successText: (result: Record<string, unknown>) => string,
): Promise<ActionResult> {
  let result: Record<string, unknown>;
  try {
    result = await operation(clientFor(runtime));
  } catch (error) {
    const text =
      error instanceof Error
        ? error.message
        : "Bitcoin Stratigraphy action failed";
    const failure: ActionResult = { success: false, text, error: text };
    if (callback) await callback({ text });
    return failure;
  }
  const response: ActionResult = {
    success: true,
    text: successText(result),
    data: result,
  };
  if (callback) {
    try {
      await callback({ text: response.text, data: result });
    } catch (error) {
      // The payment and action succeeded. Report callback failure without
      // marking the action as failed (which could trigger a second payment).
      response.error =
        error instanceof Error ? error.message : "Action callback failed";
    }
  }
  return response;
}
