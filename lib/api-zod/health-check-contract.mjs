export const HEALTH_CHECK_RESPONSE = Object.freeze({ status: "ok" });

export function isHealthCheckResponse(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.status === HEALTH_CHECK_RESPONSE.status
  );
}
