import type { Request } from "express";

/**
 * Sub-agent attribution for L402 credentials (EU AI Act Article 12 logging).
 *
 *   agent_id = <id>   <id> is 1-128 characters from A-Z a-z 0-9 . _ : @ / + = % ~ # -
 *                     and starts with a letter or digit; matching is case-sensitive
 *
 * Callers declare the ID with the X-Agent-Id header or an `agent_id` JSON body
 * field when requesting a 402 challenge. The issued macaroon carries exactly one
 * canonical caveat, and every redemption must declare the same ID. The HMAC
 * chain proves the credential was issued for that ID; it does not prove that
 * the caller controls it. Any spacing or character variant fails closed.
 */
export const AGENT_ID_HEADER = "X-Agent-Id";
const AGENT_ID = "[A-Za-z0-9][A-Za-z0-9._:@/+=%~#-]{0,127}";
export const AGENT_ID_PATTERN = new RegExp(`^${AGENT_ID}$`);
const AGENT_ID_CAVEAT = new RegExp(`^agent_id = (${AGENT_ID})$`);
const AGENT_ID_RULE =
  "1-128 characters from A-Z a-z 0-9 . _ : @ / + = % ~ # -, starting with a letter or digit";

export function formatAgentIdCaveat(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new RangeError(`agent_id must be ${AGENT_ID_RULE}`);
  }
  return `agent_id = ${agentId}`;
}

/** Returns the bound ID only for the exact canonical caveat encoding. */
export function parseAgentIdCaveat(caveat: string): string | null {
  return AGENT_ID_CAVEAT.exec(caveat)?.[1] ?? null;
}

export type AgentIdDeclaration =
  { ok: true; agentId?: string } | { ok: false; error: string };

/**
 * Reads the optional declaration from X-Agent-Id or a JSON object body field.
 * Both may be supplied only when they are identical.
 */
export function declaredAgentId(req: Request): AgentIdDeclaration {
  const header = req.get(AGENT_ID_HEADER);
  const body: unknown = req.body;
  const field =
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.hasOwn(body, "agent_id")
      ? (body as Record<string, unknown>).agent_id
      : undefined;
  if (header !== undefined && !AGENT_ID_PATTERN.test(header)) {
    return { ok: false, error: `${AGENT_ID_HEADER} must be ${AGENT_ID_RULE}` };
  }
  if (
    field !== undefined &&
    (typeof field !== "string" || !AGENT_ID_PATTERN.test(field))
  ) {
    return { ok: false, error: `agent_id must be ${AGENT_ID_RULE}` };
  }
  if (header !== undefined && field !== undefined && header !== field) {
    return {
      ok: false,
      error: `${AGENT_ID_HEADER} and body agent_id must be identical`,
    };
  }
  const agentId = header ?? (field as string | undefined);
  return agentId === undefined ? { ok: true } : { ok: true, agentId };
}

/**
 * A bound credential requires the same declaration on every use. A declaration
 * against an unbound credential is refused rather than silently unrecorded.
 */
export function agentIdCaveatRejection(
  bound: string | undefined,
  declared: string | undefined,
): { status: 403; error: string } | null {
  if (bound === declared) return null;
  if (bound === undefined) {
    return {
      status: 403,
      error:
        "L402 credential has no agent_id caveat; omit the declared agent or request a new challenge with it",
    };
  }
  return {
    status: 403,
    error:
      declared === undefined
        ? `L402 credential is bound to an agent_id; declare it with ${AGENT_ID_HEADER}`
        : "L402 credential agent_id caveat does not match the declared agent",
  };
}
