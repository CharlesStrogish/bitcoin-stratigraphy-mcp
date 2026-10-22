import type { Request } from "express";

/** W3C Trace Context: never accept zero IDs, version ff, or malformed v00. */
export function validTraceparent(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/.exec(value);
  return Boolean(match && match[1] !== "ff" && !/^0+$/.test(match[2]!)
    && !/^0+$/.test(match[3]!) && (match[1] === "00" ? match[5] === ""
      : match[5] === "" || /^-[\x21-\x7e]+$/.test(match[5]!)));
}

/** HTTP context takes precedence; do not modify the NIP-98-signed body. */
export function requestTraceparent(req: Request): string | undefined {
  const value = req.header("traceparent") ?? req.body?.params?._meta?.traceparent;
  return validTraceparent(value) ? value : undefined;
}
