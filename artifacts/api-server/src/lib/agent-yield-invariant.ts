export const AGENT_YIELD_RATE: 0.21 = 0.21; // 21% Fiduciary Invariant

export class AgentYieldInvariantError extends Error {
  readonly status = 500;
  readonly code = "AGENT_YIELD_INVARIANT_VIOLATION";
  constructor(message = "Agent yield allocation failed its invariant") {
    super(message);
    this.name = "AgentYieldInvariantError";
  }
}

/** Eligible incoming L402 revenue only. Never use clearing escrow principal. */
export function agentYieldMsats(revenueMsats: bigint): bigint {
  if (AGENT_YIELD_RATE !== 0.21 || typeof revenueMsats !== "bigint" || revenueMsats <= 0n)
    throw new AgentYieldInvariantError();
  return revenueMsats * 21n / 100n;
}

/** Independent integer cross-check: allocation = floor(revenue * 21 / 100). */
export function assertAgentYield(revenueMsats: bigint, allocationMsats: bigint): void {
  if (
    AGENT_YIELD_RATE !== 0.21 ||
    typeof revenueMsats !== "bigint" || revenueMsats <= 0n ||
    typeof allocationMsats !== "bigint" || allocationMsats < 0n ||
    allocationMsats * 100n > revenueMsats * 21n ||
    (allocationMsats + 1n) * 100n <= revenueMsats * 21n
  ) throw new AgentYieldInvariantError();
}
