export const HEALTH_CHECK_RESPONSE: Readonly<{ status: "ok" }>;

export function isHealthCheckResponse(
  value: unknown,
): value is { status: "ok" };
