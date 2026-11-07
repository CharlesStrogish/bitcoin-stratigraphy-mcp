import { createHash } from "node:crypto";
import { request } from "node:https";

export type LndTransport = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export class LndPayoutError extends Error {
  constructor(
    public readonly code: string,
    public readonly outcome: "not-sent" | "failed" | "unknown" = "not-sent",
  ) {
    super(code);
  }
}

const unsigned = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw new LndPayoutError("LND_INVALID_INTEGER");
  return BigInt(value);
};

export type ClearingPayoutPlan = Readonly<{
  invoice: string;
  paymentHash: string;
  principalMsat: bigint;
  feeLimitSat: bigint;
  escrowBalanceMsat: bigint;
  expiresAt: number;
}>;

/** Integer arithmetic only: floor(1% of escrow), further limited by headroom.
 * P + 1000*C <= E. LND enforces F <= 1000*C even if the estimate goes stale.
 */
export function clearingFeeLimit(escrowMsat: bigint, principalMsat: bigint) {
  if (
    escrowMsat <= 0n ||
    escrowMsat > BigInt(Number.MAX_SAFE_INTEGER) ||
    principalMsat <= 0n ||
    principalMsat % 1000n !== 0n ||
    principalMsat > escrowMsat
  )
    throw new LndPayoutError("CLEARING_INVALID_PAYOUT_BUDGET");
  const percentageSat = escrowMsat / 100_000n;
  const headroomSat = (escrowMsat - principalMsat) / 1000n;
  return percentageSat < headroomSat ? percentageSat : headroomSat;
}

/** No ambient configuration at import time, no redirects, no TLS bypass. */
export function lndTransportFromEnvironment(env = process.env): LndTransport {
  if (!env.LND_REST_URL || !env.LND_MACAROON)
    throw new LndPayoutError("LND_CONFIGURATION_REQUIRED");
  const base = new URL(env.LND_REST_URL);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !/^[0-9a-f]+$/i.test(env.LND_MACAROON) ||
    env.LND_MACAROON.length % 2 !== 0
  )
    throw new LndPayoutError("LND_INVALID_CONFIGURATION");
  const macaroon = env.LND_MACAROON;
  const ca = env.LND_TLS_CERT; // Optional PEM CA; otherwise use system trust.
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const url = new URL(base);
      url.pathname = base.pathname.replace(/\/$/, "") + path;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        url,
        {
          method,
          ca,
          rejectUnauthorized: true,
          headers: {
            "Grpc-Metadata-macaroon": macaroon,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
            if (text.length > 1_048_576)
              req.destroy(new Error("Response too large"));
          });
          res.on("error", () => reject(new Error("LND_RESPONSE_UNAVAILABLE")));
          res.on("end", () => {
            // Never propagate upstream bodies (they may contain private data).
            if (res.statusCode !== 200) {
              reject(new Error("LND_REQUEST_UNAVAILABLE"));
              return;
            }
            try {
              // Router SendPaymentV2 uses newline-delimited gateway envelopes.
              const messages = text
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as unknown);
              resolve(messages.length === 1 ? messages[0] : messages);
            } catch {
              reject(new Error("LND_INVALID_RESPONSE"));
            }
          });
        },
      );
      // Absolute deadline, not only an idle socket timeout. A timeout after
      // dispatch is ambiguous; the coordinator MUST retain its reservation.
      const timer = setTimeout(
        () => req.destroy(new Error("LND_TIMEOUT")),
        70_000,
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(new Error("LND_REQUEST_UNAVAILABLE")));
      req.end(payload);
    });
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LndPayoutError("LND_INVALID_RESPONSE");
  return value as Record<string, unknown>;
};

export class LndPayoutAdapter {
  private readonly prepared = new WeakSet<ClearingPayoutPlan>();
  private readonly dispatched = new WeakSet<ClearingPayoutPlan>();
  constructor(private readonly transport: LndTransport) {}

  async prepare(
    invoice: string,
    escrowBalanceMsat: bigint,
  ): Promise<ClearingPayoutPlan> {
    if (!/^lnbc[0-9a-z]+$/i.test(invoice) || invoice.length > 4096)
      throw new LndPayoutError("CLEARING_INVALID_PAYOUT_INVOICE");
    const decoded = object(
      await this.transport("GET", `/v1/payreq/${encodeURIComponent(invoice)}`),
    );
    const principalMsat = unsigned(decoded.num_msat);
    const feeLimitSat = clearingFeeLimit(escrowBalanceMsat, principalMsat);
    const paymentHash = decoded.payment_hash;
    const destination = decoded.destination;
    const expiresAt =
      Number(unsigned(decoded.timestamp) + unsigned(decoded.expiry)) * 1000;
    if (
      typeof paymentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(paymentHash) ||
      typeof destination !== "string" ||
      !/^(02|03)[0-9a-f]{64}$/.test(destination) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new LndPayoutError("CLEARING_INVALID_PAYOUT_INVOICE");
    // Graph estimate only: unlike payment_request probing this sends no HTLCs.
    const estimate = object(
      await this.transport("POST", "/v2/router/route/estimatefee", {
        dest: Buffer.from(destination, "hex").toString("base64"),
        amt_sat: (principalMsat / 1000n).toString(),
      }),
    );
    if (
      estimate.failure_reason !== undefined &&
      estimate.failure_reason !== "FAILURE_REASON_NONE" &&
      estimate.failure_reason !== 0
    )
      throw new LndPayoutError("LND_ROUTE_UNAVAILABLE");
    if (unsigned(estimate.routing_fee_msat) > feeLimitSat * 1000n)
      throw new LndPayoutError("CLEARING_ROUTING_FEE_CAP_EXCEEDED");
    const plan = Object.freeze({
      invoice,
      paymentHash,
      principalMsat,
      feeLimitSat,
      escrowBalanceMsat,
      expiresAt,
    });
    this.prepared.add(plan);
    return plan;
  }

  async pay(
    plan: ClearingPayoutPlan,
  ): Promise<{ feeMsat: bigint; preimage: string }> {
    // Revalidate even internally supplied plans; never trust an arbitrary cap.
    if (
      !this.prepared.has(plan) ||
      this.dispatched.has(plan) ||
      plan.feeLimitSat !==
        clearingFeeLimit(plan.escrowBalanceMsat, plan.principalMsat) ||
      plan.expiresAt <= Date.now()
    )
      throw new LndPayoutError("CLEARING_INVALID_PAYOUT_PLAN");
    this.dispatched.add(plan);
    try {
      const response = await this.transport("POST", "/v2/router/send", {
        payment_request: plan.invoice,
        fee_limit_sat: plan.feeLimitSat.toString(),
        timeout_seconds: 60,
        no_inflight_updates: true,
      });
      const messages = Array.isArray(response) ? response : [response];
      const terminal = object(messages.at(-1));
      const payment = object(terminal.result ?? terminal);
      if (payment.payment_hash !== plan.paymentHash)
        throw new Error("Unbound payment");
      if (payment.status === "FAILED")
        throw new LndPayoutError("LND_PAYMENT_FAILED", "failed");
      const feeMsat = unsigned(payment.fee_msat);
      const preimage = payment.payment_preimage;
      if (
        payment.status !== "SUCCEEDED" ||
        unsigned(payment.value_msat) !== plan.principalMsat ||
        feeMsat > plan.feeLimitSat * 1000n ||
        typeof preimage !== "string" ||
        !/^[0-9a-f]{64}$/.test(preimage) ||
        createHash("sha256")
          .update(Buffer.from(preimage, "hex"))
          .digest("hex") !== plan.paymentHash
      )
        throw new Error("Invalid terminal payment evidence");
      return { feeMsat, preimage };
    } catch (error) {
      if (error instanceof LndPayoutError && error.outcome === "failed")
        throw error;
      throw new LndPayoutError("LND_PAYMENT_OUTCOME_UNKNOWN", "unknown");
    }
  }
}
