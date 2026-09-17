import type { AgentIdentity, AgentTier } from "./agentReputation";

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;
const AGENT_TIERS = new Set<AgentTier>(["STANDARD", "VIP", "SWARM"]);

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
  return [
    `agent_pubkey=${identity.pubkey}`,
    `agent_tier=${identity.tier}`,
  ];
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