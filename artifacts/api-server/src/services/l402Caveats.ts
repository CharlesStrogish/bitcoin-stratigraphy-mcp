import type { AgentIdentity, AgentTier } from "./agentReputation";
import { SETTLEMENT_ASSETS, type SettlementAsset } from "./settlement/types";

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;
const AGENT_TIERS = new Set<AgentTier>(["STANDARD", "VIP", "SWARM"]);
const PAYMENT_ASSETS = new Set<SettlementAsset>(SETTLEMENT_ASSETS);

export type AgentIdentityCaveats = {
  agentPubkey: string;
  agentTier: AgentTier;
};

export function constructAgentIdentityCaveats(
  identity?: Pick<AgentIdentity, "pubkey" | "tier">,
): string[] {
  if (!identity) return [];
  if (
    !PUBKEY_PATTERN.test(identity.pubkey) ||
    !AGENT_TIERS.has(identity.tier)
  ) {
    throw new Error("Cannot bind an invalid agent identity");
  }
  return [`agent_pubkey=${identity.pubkey}`, `agent_tier=${identity.tier}`];
}

export function parseAgentIdentityCaveats(
  values: ReadonlyMap<string, string>,
): AgentIdentityCaveats | null | undefined {
  const agentPubkey = values.get("agent_pubkey");
  const agentTier = values.get("agent_tier") as AgentTier | undefined;
  if (agentPubkey === undefined && agentTier === undefined) return undefined;
  if (
    !agentPubkey ||
    !agentTier ||
    !PUBKEY_PATTERN.test(agentPubkey) ||
    !AGENT_TIERS.has(agentTier)
  ) {
    return null;
  }
  return { agentPubkey, agentTier };
}

export function presentingAgentMatchesCaveats(
  caveats: AgentIdentityCaveats | undefined,
  presenting?: Pick<AgentIdentity, "pubkey" | "tier">,
): boolean {
  if (!caveats) return true;
  return (
    presenting?.pubkey === caveats.agentPubkey &&
    presenting.tier === caveats.agentTier
  );
}

export function constructPaymentAssetCaveat(asset?: SettlementAsset): string[] {
  if (!asset) return [];
  if (!PAYMENT_ASSETS.has(asset)) {
    throw new Error("Cannot bind an invalid settlement asset");
  }
  return [`payment_asset=${asset}`];
}

export function constructPaymentProviderCaveat(provider?: string): string[] {
  if (!provider) return [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) {
    throw new Error("Cannot bind an invalid settlement provider");
  }
  return [`payment_provider=${provider}`];
}

export function parsePaymentProviderCaveat(
  values: ReadonlyMap<string, string>,
): string | null | undefined {
  const value = values.get("payment_provider");
  if (value === undefined) return undefined;
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

export function parsePaymentAssetCaveat(
  values: ReadonlyMap<string, string>,
): SettlementAsset | null | undefined {
  const value = values.get("payment_asset");
  if (value === undefined) return undefined;
  return PAYMENT_ASSETS.has(value as SettlementAsset)
    ? (value as SettlementAsset)
    : null;
}
