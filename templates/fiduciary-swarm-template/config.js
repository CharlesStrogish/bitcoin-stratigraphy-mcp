import { createPublicKey } from "node:crypto";
import { resolve } from "node:path";

export const MCP_URL = "https://bitcoinstratigraphy.com/mcp";
export const BUDGET = Object.freeze({
  maxPaymentSats: 50,
  maxTotalSats: 250,
  max_spend_sats: 250,
  feeReserveSats: 1,
});

export class ConfigurationError extends Error {}

/** Read configuration without printing credentials or discovering a trust pin. */
export function loadConfig(env = process.env) {
  for (const name of ["OPENAI_API_KEY", "NWC_URI", "FIDUCIARY_SERVER_PUBLIC_KEY"]) {
    if (typeof env[name] !== "string" || !env[name].trim()) {
      throw new ConfigurationError(`Set ${name} before starting the agent.`);
    }
  }
  if (!env.NWC_URI.startsWith("nostr+walletconnect://")) {
    throw new ConfigurationError("NWC_URI must be an authorized NWC pairing URI.");
  }
  const serverPublicKey = env.FIDUCIARY_SERVER_PUBLIC_KEY.replace(/\\n/g, "\n").trim();
  try {
    if (!serverPublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
        createPublicKey(serverPublicKey).asymmetricKeyType !== "ed25519") {
      throw new Error("Invalid public-key pin");
    }
  } catch {
    throw new ConfigurationError(
      "FIDUCIARY_SERVER_PUBLIC_KEY must contain an independently trusted Ed25519 SPKI public-key PEM.",
    );
  }
  return {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    nwcUri: env.NWC_URI,
    serverPublicKey,
    stateDirectory: resolve(".fiduciary-state"),
  };
}
