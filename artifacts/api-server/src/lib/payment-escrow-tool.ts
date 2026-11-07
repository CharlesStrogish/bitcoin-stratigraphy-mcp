import type { RequestHandler } from "express";
import { verifyRequestNip98Signer } from "./nip98-request";
import type { YieldStaking } from "./yield-staking";

export const paymentEscrowToolDefinition = {
  name: "payment.get_escrow",
  title: "Read Authenticated Yield Staking Escrow",
  description: "PURPOSE & BOUNDARIES: Read the requesting NIP-98 signer's private staked yield in whole sats. Do NOT use this to withdraw or transfer funds, discover tool prices, or verify settlement; use payment.get_info for pricing and payment checks. USAGE GUIDELINES: Send empty arguments with fresh Nostr HTTP authentication bound to the exact URL, method and request body. No pubkey argument is accepted. BEHAVIOR & CONSEQUENCES: Free and read-only; missing or invalid authentication fails before lookup, and unavailable storage fails explicitly. vip_status is true strictly above 10000 sats. zero_latency_routing is an informational feature label, not a payment bypass or latency guarantee.",
  inputSchema: {
    type: "object", description: "No arguments; ownership comes only from fresh request-bound NIP-98 authentication.",
    examples: [{}], properties: {}, required: [], additionalProperties: false,
  },
  outputSchema: {
    type: "object", additionalProperties: false,
    description: "The authenticated signer's private escrow balance, floored to whole sats without discarding stored fractional sats.",
    examples: [{ pubkey: "ab".repeat(32), staked_sats: 10001, vip_status: true,
      unlocked_features: ["zero_latency_routing"] }],
    properties: {
      pubkey: { type: "string", pattern: "^[0-9a-f]{64}$",
        description: "The fresh NIP-98 signer's public key.", examples: ["ab".repeat(32)] },
      staked_sats: { type: "integer", minimum: 0,
        description: "Accumulated staked yield floored to whole satoshis.", examples: [10001] },
      vip_status: { type: "boolean",
        description: "True strictly above 10000 whole staked sats.", examples: [true] },
      unlocked_features: { type: "array",
        description: "Informational feature identifiers; never a payment bypass or latency guarantee.",
        examples: [["zero_latency_routing"]],
        items: { type: "string", enum: ["zero_latency_routing"],
          description: "Requested informational routing feature label.", examples: ["zero_latency_routing"] } },
    },
    required: ["pubkey", "staked_sats", "vip_status", "unlocked_features"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function paymentEscrowAuthentication(store?: YieldStaking, now = Date.now): RequestHandler {
  return async (req, res, next) => {
    if (req.body?.method !== "tools/call" || req.body.params?.name !== "payment.get_escrow") {
      next(); return;
    }
    res.set("Cache-Control", "no-store");
    const args = req.body.params.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length ||
        req.body.params.task !== undefined) {
      res.status(400).json({ jsonrpc: "2.0", id: req.body.id ?? null,
        error: { code: -32602, message: "payment.get_escrow accepts no arguments or task delivery" } }); return;
    }
    const signer = verifyRequestNip98Signer(req, now());
    if (!signer.provided || !signer.pubkey) {
      res.status(401).json({ error: "NIP98_AUTHENTICATION_REQUIRED" }); return;
    }
    try {
      if (await req.app.locals.swarmReferralRevoked?.(signer.pubkey)) {
        res.status(403).json({ error: "STAKING_IDENTITY_REVOKED" }); return;
      }
      const ledger: YieldStaking | undefined = store ?? req.app.locals.yieldStaking;
      if (!ledger) throw new Error("Staking unavailable");
      res.locals.yieldEscrow = await ledger.get(signer.pubkey);
      next();
    } catch {
      res.status(503).json({ error: "STAKING_LEDGER_UNAVAILABLE" });
    }
  };
}
