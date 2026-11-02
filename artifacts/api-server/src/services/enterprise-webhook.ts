/** Allowlisted monitoring data only: never pass credentials or payment proofs. */
export type EnterpriseSettlementNotice = {
  transaction_id: string;
  satoshis_captured: number;
  timestamp: string;
};

export function createEnterpriseWebhookDispatcher(options: {
  getUrl?: () => string | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxInFlight?: number;
} = {}) {
  const getUrl = options.getUrl ?? (() => process.env.ENTERPRISE_WEBHOOK_URL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxInFlight = options.maxInFlight ?? 16;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) {
    throw new RangeError("Invalid enterprise webhook dispatch limits");
  }
  let inFlight = 0;

  return {
    get inFlight() { return inFlight; },
    /** Best effort, no retries/queue, no awaited network work on the caller. */
    dispatch(notice: EnterpriseSettlementNotice): void {
      try {
        const endpoint = getUrl();
        if (!endpoint || inFlight >= maxInFlight) return;
        // Snapshot only primitives; do all validation/serialization/network work
        // on a later event-loop turn, after returning to the paid request.
        const snapshot = {
          transaction_id: notice.transaction_id,
          satoshis_captured: notice.satoshis_captured,
          timestamp: notice.timestamp,
        };
        inFlight++;
        const task = setImmediate(() => {
          void (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const url = new URL(endpoint);
              if (!["https:", "http:"].includes(url.protocol) ||
                  url.username || url.password ||
                  !snapshot.transaction_id ||
                  !Number.isSafeInteger(snapshot.satoshis_captured) ||
                  snapshot.satoshis_captured <= 0 ||
                  !Number.isFinite(Date.parse(snapshot.timestamp))) return;
              const controller = new AbortController();
              const deadline = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error("Enterprise webhook timeout"));
                }, timeoutMs);
                timer.unref();
              });
              const response = await Promise.race([
                fetchImpl(url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  redirect: "error",
                  signal: controller.signal,
                  body: JSON.stringify({
                    transaction_id: snapshot.transaction_id,
                    satoshis_captured: snapshot.satoshis_captured,
                    // Integer hundredths of a satoshi, exposed as JSON sats.
                    yield_distributed: Number(BigInt(snapshot.satoshis_captured) * 21n) / 100,
                    timestamp: snapshot.timestamp,
                  }),
                }),
                deadline,
              ]);
              // Never read or retain an arbitrary corporate response body.
              void response.body?.cancel().catch(() => undefined);
            } catch {
              // Never log destination URLs (e.g. Slack secrets), response
              // bodies or fetch errors. Delivery cannot affect settlement.
            } finally {
              if (timer) clearTimeout(timer);
              inFlight--;
            }
          })().catch(() => undefined);
        });
        task.unref();
      } catch {
        // Includes missing/misconfigured environment and synchronous failures.
      }
    },
  };
}

const enterpriseWebhook = createEnterpriseWebhookDispatcher();
export const dispatchEnterpriseSettlement = enterpriseWebhook.dispatch;
