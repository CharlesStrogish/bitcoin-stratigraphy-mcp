import { createHash } from "node:crypto";
import { NWCClient } from "@getalby/sdk";
import {
  SettlementProviderError,
  type SettlementInvoiceInput,
  type SettlementProvider,
  type SettlementVerificationInput,
} from "./types";

export type NwcClient = Pick<
  NWCClient,
  "lookupInvoice" | "makeInvoice" | "close"
>;
export type NwcClientFactory = (nwcUri: string) => NwcClient;

const silentNwcLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const createNwcClient: NwcClientFactory = (nwcUri) =>
  new NWCClient({
    nostrWalletConnectUrl: nwcUri,
    logger: silentNwcLogger,
  });

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
  ]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

function retryableProviderError(error: unknown) {
  const status = statusCode(error);
  if (status !== undefined) return status >= 500;
  if (!(error instanceof Error)) return false;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  return (
    error.name === "AbortError" ||
    /timeout|timed out|network|socket|fetch failed|connection|econn/i.test(
      `${code} ${error.message}`,
    )
  );
}

export function createNwcSettlementProvider(input: {
  name: string;
  uri: () => string | undefined;
  clientFactory?: NwcClientFactory;
}): SettlementProvider {
  const clientFactory = input.clientFactory ?? createNwcClient;
  const configuredUri = () => input.uri()?.trim() || undefined;

  return {
    name: input.name,
    isConfigured: () => configuredUri() !== undefined,
    async createInvoice(request: SettlementInvoiceInput) {
      const uri = configuredUri();
      if (!uri) {
        throw new SettlementProviderError(
          `${input.name} settlement is not configured`,
          true,
        );
      }
      const client = clientFactory(uri);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        client.close();
      };
      const abort = () => close();
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (request.signal?.aborted) {
          throw new SettlementProviderError(
            `${input.name} invoice generation aborted`,
            true,
          );
        }
        const transaction = await client.makeInvoice({
          amount: request.amountMsats,
          description: request.description,
          expiry: request.expirySeconds,
        });
        if (
          !transaction.invoice.startsWith("ln") ||
          !/^[0-9a-fA-F]{64}$/.test(transaction.payment_hash)
        ) {
          throw new SettlementProviderError(
            `${input.name} returned an incomplete NWC invoice`,
            false,
          );
        }
        return {
          invoice: transaction.invoice,
          paymentHash: transaction.payment_hash.toLowerCase(),
          provider: input.name,
        };
      } catch (error) {
        if (error instanceof SettlementProviderError) throw error;
        throw new SettlementProviderError(
          `${input.name} invoice generation failed`,
          retryableProviderError(error),
          { cause: error },
        );
      } finally {
        request.signal?.removeEventListener("abort", abort);
        close();
      }
    },
    async verifyPayment(request: SettlementVerificationInput) {
      const computedHash = createHash("sha256")
        .update(Buffer.from(request.preimage, "hex"))
        .digest("hex");
      if (computedHash !== request.paymentHash) return "invalid";
      const uri = configuredUri();
      if (!uri) {
        throw new SettlementProviderError(
          `${input.name} settlement is not configured`,
          true,
        );
      }
      const client = clientFactory(uri);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        client.close();
      };
      const abort = () => close();
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (request.signal?.aborted) {
          throw new SettlementProviderError(
            `${input.name} payment verification aborted`,
            true,
          );
        }
        const transaction = await client.lookupInvoice({
          payment_hash: request.paymentHash,
        });
        const valid =
          transaction.type === "incoming" &&
          transaction.state === "settled" &&
          transaction.amount === request.expectedAmountMsats &&
          transaction.description === request.expectedDescription &&
          transaction.payment_hash.toLowerCase() === request.paymentHash &&
          (!transaction.preimage ||
            transaction.preimage.toLowerCase() === request.preimage);
        return valid
          ? {
              settledAt:
                typeof transaction.settled_at === "number"
                  ? transaction.settled_at
                  : 0,
              provider: input.name,
            }
          : "invalid";
      } catch (error) {
        throw new SettlementProviderError(
          `${input.name} payment verification failed`,
          retryableProviderError(error),
          { cause: error },
        );
      } finally {
        request.signal?.removeEventListener("abort", abort);
        close();
      }
    },
  };
}