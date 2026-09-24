import { BitcoinStratigraphyClient as RestClient } from "@bitcoin-stratigraphy/sdk";
import { BitcoinStratigraphyClient as McpClient } from "@bitcoin-stratigraphy/sdk/mcp";
import { runAgentLoop } from "./agentLoop.js";
import { createStateStore } from "./state.js";
import { createNwcWallet } from "./wallet.js";

async function main(): Promise<void> {
  const secret = process.env.NWC_PAIRING_SECRET;
  if (!secret) throw new Error("Set NWC_PAIRING_SECRET in Replit Secrets");

  const suppliedUrl = process.env.STRATIGRAPHY_SERVER_URL ??
    "https://bitcoin-stratigraphy-dashboard.replit.app";
  const server = new URL(suppliedUrl);
  if (!["https:", "http:"].includes(server.protocol) ||
      (server.pathname !== "/" && server.pathname !== "")) {
    throw new Error("STRATIGRAPHY_SERVER_URL must be the HTTP(S) REST origin without /mcp");
  }
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 3_600_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 900_000) {
    throw new Error("POLL_INTERVAL_MS must be at least 900000 (15 minutes)");
  }

  // Open durable state before creating the wallet or requesting paid data.
  const store = await createStateStore();
  let wallet: ReturnType<typeof createNwcWallet> | undefined;
  try {
    wallet = createNwcWallet(secret);
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    await runAgentLoop({
      rest: new RestClient({ baseUrl: server.origin, wallet, tier: "1-day" }),
      mcp: new McpClient(`${server.origin}/mcp`, wallet.payMcpInvoice),
      store,
      emit: (event) => console.log(JSON.stringify({
        time: new Date().toISOString(), ...event,
      })),
    }, intervalMs, controller.signal);
  } finally {
    wallet?.close();
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Agent startup failed");
  process.exitCode = 1;
});