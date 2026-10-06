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
> &
  Partial<Pick<NWCClient, "listTransactions">>;
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
  payerUri?: () => string | undefined;
  clientFactory?: NwcClientFactory;
}): SettlementProvider {
  const clientFactory = input.clientFactory ?? createNwcClient;
  const configuredUri = () => input.uri()?.trim() || undefined;

  return {
    name: input.name,
    isConfigured: () => configuredUri() !== undefined,
    async createInvoice(request: SettlementInvoiceInput) {
      if (
        (request.asset && request.asset !== "btc-lightning") ||
        !Number.isSafeInteger(request.amountMsats) ||
        request.amountMsats <= 0 ||
        !Number.isSafeInteger(request.expirySeconds) ||
        request.expirySeconds <= 0 ||
        typeof request.description !== "string" ||
        request.description.length === 0
      ) {
        throw new SettlementProviderError(
          `${input.name} received an invalid Lightning invoice request`,
          false,
        );
      }
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
          asset: "btc-lightning",
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
      const isHexPreimage = /^[0-9a-f]{64}$/.test(request.preimage);
      const isCoinosReference =
        input.name === "coinos" &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request.preimage);
      if (
        !/^[0-9a-f]{64}$/.test(request.paymentHash) ||
        (!isHexPreimage && !isCoinosReference) ||
        (request.asset && request.asset !== "btc-lightning") ||
        !Number.isSafeInteger(request.expectedAmountMsats) ||
        request.expectedAmountMsats <= 0
      ) {
        return "invalid";
      }
      if (isHexPreimage) {
        const computedHash = createHash("sha256")
          .update(Buffer.from(request.preimage, "hex"))
          .digest("hex");
        if (computedHash !== request.paymentHash) return "invalid";
      }
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
        const transactionPaymentHash =
          typeof transaction.payment_hash === "string"
            ? transaction.payment_hash.toLowerCase()
            : "";
        const transactionPreimage =
          typeof transaction.preimage === "string"
            ? transaction.preimage.toLowerCase()
            : undefined;
        const valid =
          transaction.type === "incoming" &&
          transaction.state === "settled" &&
          (isCoinosReference ||
            transaction.amount === request.expectedAmountMsats) &&
          transaction.description === request.expectedDescription &&
          transactionPaymentHash === request.paymentHash &&
          (isCoinosReference ||
            ((!transactionPreimage ||
              transactionPreimage === request.preimage) &&
              (transactionPreimage === undefined ||
                /^[0-9a-f]{64}$/.test(transactionPreimage)))) &&
          (transaction.settled_at === undefined ||
            (typeof transaction.settled_at === "number" &&
              Number.isSafeInteger(transaction.settled_at) &&
              transaction.settled_at > 0));
        if (!valid) return "invalid";
        if (isCoinosReference) {
          // CoinOS returns the outgoing payment ID, not a Lightning preimage,
          // for internal transfers. The issuing wallet must see BOTH the paid
          // incoming invoice and that exact outgoing payment in its own account.
          const settledAt = transaction.settled_at;
          if (
            !Number.isSafeInteger(settledAt) ||
            !settledAt ||
            typeof transaction.invoice !== "string"
          )
            return "invalid";
          const from = Math.max(0, settledAt - 3_600);
          const until = settledAt + 3_600;
          const matchesTransaction = async (
            wallet: NwcClient,
            type: "incoming" | "outgoing",
          ): Promise<boolean> => {
            if (!wallet.listTransactions) return false;
            for (let offset = 0; offset < 500; offset += 100) {
              if (request.signal?.aborted) return false;
              const page = await wallet.listTransactions({
                type,
                from,
                until,
                limit: 100,
                offset,
              });
              if (!Array.isArray(page.transactions)) return false;
              if (
                page.transactions.some(
                  (payment) =>
                    payment.type === type &&
                    payment.state === "settled" &&
                    (type === "incoming" ||
                      payment.payment_hash?.toLowerCase() ===
                        request.preimage.toLowerCase()) &&
                    payment.invoice === transaction.invoice &&
                    payment.amount === request.expectedAmountMsats &&
                    typeof payment.created_at === "number" &&
                    payment.created_at >= from &&
                    payment.created_at <= until,
                )
              )
                return true;
              if (page.transactions.length < 100) break;
            }
            return false;
          };
          // Internal credits may leave CLN's amount_received_msat unset. The
          // issuer's incoming transaction list supplies the actual credited amount.
          if (!(await matchesTransaction(client, "incoming"))) return "invalid";
          if (await matchesTransaction(client, "outgoing")) {
            return { settledAt, provider: input.name, asset: "btc-lightning" };
          }
          const payerUri = input.payerUri?.()?.trim();
          if (payerUri && payerUri !== uri) {
            const payer = clientFactory(payerUri);
            const closePayer = () => payer.close();
            request.signal?.addEventListener("abort", closePayer, {
              once: true,
            });
            try {
              if (
                !request.signal?.aborted &&
                (await matchesTransaction(payer, "outgoing"))
              ) {
                return {
                  settledAt,
                  provider: input.name,
                  asset: "btc-lightning",
                };
              }
            } finally {
              request.signal?.removeEventListener("abort", closePayer);
              payer.close();
            }
          }
          return "invalid";
        }
        return valid
          ? {
              settledAt:
                typeof transaction.settled_at === "number"
                  ? transaction.settled_at
                  : 0,
              provider: input.name,
              asset: "btc-lightning",
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
