import { createHash } from "node:crypto";
import { BitcoinStratigraphyClient as RestClient } from "@bitcoin-stratigraphy/sdk";
import { BitcoinStratigraphyClient as McpClient } from "@bitcoin-stratigraphy/sdk/mcp";
import { runAgentLoop, type AgentEvent } from "./agentLoop.js";
import { createStateStore } from "./state.js";
import { createNwcWallet } from "./wallet.js";

export function requireNwcPairingSecret(env: NodeJS.ProcessEnv): string {
  if (env.NWC_PAIRING_SECRET) return env.NWC_PAIRING_SECRET;
  if (env.LNURL_PAYMENT_KEY) {
    throw new Error(
      "LNURL_PAYMENT_KEY alone cannot safely settle L402 invoices. " +
        "Set NWC_PAIRING_SECRET; LNbits and Alby tokens require an explicit provider adapter.",
    );
  }
  throw new Error("Set NWC_PAIRING_SECRET in Replit Secrets");
}

function serverOrigin(value: string): string {
  const server = new URL(value);
  if (
    !["https:", "http:"].includes(server.protocol) ||
    (server.pathname !== "/" && server.pathname !== "") ||
    server.username ||
    server.password ||
    server.search ||
    server.hash
  ) {
    throw new Error(
      "STRATIGRAPHY_SERVER_URL must be an HTTP(S) REST origin without credentials or /mcp",
    );
  }
  return server.origin;
}

export function redactDiagnostic(text: string): string {
  let result = text;
  for (const secret of [
    process.env.NWC_PAIRING_SECRET,
    process.env.LNURL_PAYMENT_KEY,
    process.env.DATABASE_URL,
    process.env.REPLIT_DB,
  ]) {
    if (secret && secret.length >= 5)
      result = result.replaceAll(secret, "[redacted]");
  }
  return result
    .replace(/nostr\+walletconnect:\/\/[^\s"'<>]+/gi, "[redacted NWC URI]")
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted DB URL]")
    .replace(/L402\s+[^\s"'<>]+/gi, "[redacted L402 authorization]")
    .replace(/\b(?:lnbc|lntb|lnbcrt)[0-9a-z]+\b/gi, "[redacted invoice]")
    .replace(
      /\b(macaroon|invoice|preimage|payment_preimage|token)\s*[:=]\s*["']?[^\s,"'}]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b[0-9a-f]{64}\b/gi, "[redacted payment bytes]");
}

function logEvent(
  event: AgentEvent | { type: "payment"; invoiceHash: string },
): void {
  // Keep the original message/stack useful without leaking payment material.
  const safeEvent =
    event.type === "error"
      ? {
          type: "error",
          error: redactDiagnostic(event.error),
          ...(event.stack ? { stack: redactDiagnostic(event.stack) } : {}),
        }
      : event;
  console.log(JSON.stringify({ time: new Date().toISOString(), ...safeEvent }));
}

export function logStartupError(error: unknown): void {
  logEvent({
    type: "error",
    error:
      error instanceof Error ? error.message : "Unknown worker startup error",
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
}

export async function runWorker(intervalMs: number): Promise<void> {
  const secret = requireNwcPairingSecret(process.env);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 900_000) {
    throw new Error("Polling interval must be at least 900000 ms (15 minutes)");
  }
  const origin = serverOrigin(
    process.env.STRATIGRAPHY_SERVER_URL ?? "https://bitcoinstratigraphy.com",
  );

  // Production requires persistent checkpoints; establish storage before any payment.
  const store = await createStateStore();
  let wallet: ReturnType<typeof createNwcWallet> | undefined;
  try {
    // Check the state before paying: unreadable local data must not be
    // discovered only after an invoice has already been settled.
    await store.load();
    wallet = createNwcWallet(secret, (invoice) => {
      logEvent({
        type: "payment",
        invoiceHash: createHash("sha256").update(invoice).digest("hex"),
      });
    });
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    await runAgentLoop(
      {
        rest: new RestClient({ baseUrl: origin, wallet, tier: "1-day" }),
        mcp: new McpClient(`${origin}/mcp`, wallet.payMcpInvoice),
        store,
        emit: logEvent,
      },
      intervalMs,
      controller.signal,
    );
  } finally {
    wallet?.close();
    await store.close();
  }
}
