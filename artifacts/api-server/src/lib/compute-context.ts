import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { verifyRequestNip98Signer } from "./nip98-request";

type ComputeContext = { identity: string; signal?: AbortSignal };
const context = new AsyncLocalStorage<ComputeContext>();

export const computeContext = () => context.getStore();
export function withComputeContext<T>(value: ComputeContext, work: () => T): T {
  return context.run(value, work);
}

/** Scheduling metadata only. This never grants access or replaces payment/auth checks. */
export const computeRequestContext: RequestHandler = (req, res, next) => {
  const signer = verifyRequestNip98Signer(req, Date.now());
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!res.writableEnded) abort();
    req.off("aborted", abort);
    res.off("close", close);
  };
  req.once("aborted", abort);
  res.once("close", close);
  withComputeContext({
    get identity() {
      if (signer.provided && signer.pubkey) return signer.pubkey;
      // Read only the server-populated settlement result, never a payment hash
      // or agent ID supplied in headers. Legacy paid callers retain independent
      // buckets, while descendants of the same paid root share a budget.
      const paid = res.locals.l402 as { paymentHash?: unknown; settledAt?: unknown } | undefined;
      return typeof paid?.paymentHash === "string" && typeof paid.settledAt === "number" && paid.settledAt > 0
        ? `l402:${paid.paymentHash}` : "anonymous";
    },
    signal: controller.signal,
  }, next);
};
