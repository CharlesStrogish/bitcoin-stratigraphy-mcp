// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.

/** Log only diagnostic identifiers, never SDK error objects/messages/URLs/keys. */
export function fiatErrorDiagnostics(error: unknown, stage: string) {
  const entry =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const identifier = (value: unknown) =>
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,80}$/.test(value) &&
    !/^(?:sk_|rk_|pk_|whsec_|nsec|ghp_)/i.test(value)
      ? value
      : undefined;
  return {
    fiatStage: stage,
    errorName: identifier(entry.name),
    errorType: identifier(entry.type),
    errorCode: identifier(entry.code),
    httpStatus:
      Number.isInteger(entry.statusCode) &&
      Number(entry.statusCode) >= 100 &&
      Number(entry.statusCode) <= 599
        ? entry.statusCode
        : undefined,
    stripeRequestId:
      typeof entry.requestId === "string" &&
      /^req_[A-Za-z0-9]+$/.test(entry.requestId)
        ? entry.requestId
        : undefined,
  };
}

export function fiatSyncStage(description: unknown): string {
  if (typeof description !== "string") return "sync";
  if (description.includes("retrieve account from Stripe API"))
    return "stripe_account_read";
  if (description.includes("upsert account to database"))
    return "stripe_account_upsert";
  if (description.includes("lookup account by API key hash"))
    return "stripe_account_cache";
  if (description.includes("backfill")) return "stripe_backfill";
  return "sync";
}
