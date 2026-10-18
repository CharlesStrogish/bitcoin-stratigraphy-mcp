/**
 * Strict grammar for first-party delegation caveats on L402 macaroons.
 *
 * Macaroon signatures chain over the exact caveat bytes, so verification
 * accepts only these canonical encodings. Any variant (different spacing,
 * another timestamp form, duplicate tools, unknown keys) fails closed instead
 * of being interpreted.
 *
 *   time < YYYY-MM-DDTHH:MM:SS.sssZ  requests are rejected at or after this UTC instant
 *   rpc = tool[,tool...]              only these exact MCP tool names may execute (1-16, unique)
 *
 * Earlier delegation forms stay verifiable so issued credentials keep working:
 *
 *   time_before=YYYY-MM-DD | YYYY-MM-DDTHH:MM:SS.sssZ  (a date-only bound includes that UTC date)
 *   allowed_tools=tool[,tool...]                        (legacy tool aliases are equivalent)
 *   allowed_path=/path   max_requests=N   max_target=N
 */

const TOOL_NAME = "[a-z][a-z0-9]*\\.[a-z][a-z0-9_]*";
const TOOL_LIST = `${TOOL_NAME}(?:,${TOOL_NAME})*`;
const ISO_INSTANT = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";

const TIME_CAVEAT = new RegExp(`^time < (${ISO_INSTANT})$`);
const RPC_CAVEAT = new RegExp(`^rpc = (${TOOL_LIST})$`);
const LEGACY_TIME_BEFORE = new RegExp(
  `^(?:\\d{4}-\\d{2}-\\d{2}|${ISO_INSTANT})$`,
);
const LEGACY_TOOL_LIST = new RegExp(`^${TOOL_LIST}$`);

export const MCP_TOOL_NAME_PATTERN = new RegExp(`^${TOOL_NAME}$`);
export const MAX_RPC_TOOLS = 16;

export type DelegationCaveat =
  /** Exclusive deadline in epoch milliseconds, from `time <` or `time_before`. */
  | { type: "time"; deadline: number }
  /** Exact tool names from one `rpc =` caveat; every rpc caveat must name the tool. */
  | { type: "rpc"; tools: string[] }
  /** Legacy alias-equivalent allowlist from one `allowed_tools` caveat. */
  | { type: "allowed_tools"; tools: string[] }
  | { type: "allowed_path"; path: string }
  | { type: "max_requests"; limit: number }
  | { type: "max_target"; height: number };

/** Parses an instant only when it is already in canonical ISO form. */
function canonicalInstant(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : null;
}

/** Returns null for anything that is not an exactly formatted delegation caveat. */
export function parseDelegationCaveat(caveat: string): DelegationCaveat | null {
  const time = TIME_CAVEAT.exec(caveat);
  if (time) {
    const deadline = canonicalInstant(time[1]!);
    return deadline === null ? null : { type: "time", deadline };
  }
  const rpc = RPC_CAVEAT.exec(caveat);
  if (rpc) {
    const tools = rpc[1]!.split(",");
    return tools.length <= MAX_RPC_TOOLS && new Set(tools).size === tools.length
      ? { type: "rpc", tools }
      : null;
  }
  const separator = caveat.indexOf("=");
  if (separator <= 0) return null;
  const key = caveat.slice(0, separator);
  const value = caveat.slice(separator + 1);
  if (key === "allowed_path") {
    return /^\/[^\s]*$/.test(value)
      ? { type: "allowed_path", path: value }
      : null;
  }
  if (key === "max_requests" || key === "max_target") {
    const number = Number(value);
    if (
      !(key === "max_requests" ? /^[1-9]\d*$/ : /^(?:0|[1-9]\d*)$/).test(
        value,
      ) ||
      !Number.isSafeInteger(number)
    ) {
      return null;
    }
    return key === "max_requests"
      ? { type: "max_requests", limit: number }
      : { type: "max_target", height: number };
  }
  if (key === "time_before") {
    if (!LEGACY_TIME_BEFORE.test(value)) return null;
    const dateOnly = value.length === 10;
    const start = canonicalInstant(dateOnly ? `${value}T00:00:00.000Z` : value);
    // A date-only bound includes that whole UTC date; timestamps are exclusive.
    return start === null
      ? null
      : { type: "time", deadline: start + (dateOnly ? 86_400_000 : 0) };
  }
  if (key === "allowed_tools") {
    return LEGACY_TOOL_LIST.test(value)
      ? { type: "allowed_tools", tools: value.split(",") }
      : null;
  }
  return null;
}

/** Formats an exclusive UTC deadline (integer epoch milliseconds) as `time < …`. */
export function formatTimeCaveat(deadline: number): string {
  const date = new Date(deadline);
  const caveat =
    Number.isSafeInteger(deadline) && Number.isFinite(date.getTime())
      ? `time < ${date.toISOString()}`
      : "";
  if (parseDelegationCaveat(caveat)?.type !== "time") {
    throw new RangeError(
      "Time caveat requires a UTC instant between years 0000 and 9999",
    );
  }
  return caveat;
}

/** Formats exact MCP tool targets as `rpc = …`. */
export function formatRpcCaveat(tools: readonly string[]): string {
  const caveat = `rpc = ${tools.join(",")}`;
  if (parseDelegationCaveat(caveat)?.type !== "rpc") {
    throw new RangeError(
      `rpc caveat requires 1-${MAX_RPC_TOOLS} unique MCP tool names`,
    );
  }
  return caveat;
}
