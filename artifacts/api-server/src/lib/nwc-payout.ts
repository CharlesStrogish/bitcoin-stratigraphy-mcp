import { createHash } from "node:crypto";
import { NWCClient, Nip47WalletError } from "@getalby/sdk";
import type { YieldWithdrawalInvoice } from "./yield-withdrawal-invoice";

export type PayoutOutcome =
  | { status: "settled"; txid?: string; preimage?: string }
  | { status: "failed"; code: string }
  | { status: "pending" };
export interface NwcPayout {
  configured(): boolean;
  pay(invoiceText: string, invoice: YieldWithdrawalInvoice): Promise<PayoutOutcome>;
  lookup(invoice: YieldWithdrawalInvoice): Promise<PayoutOutcome>;
}
export type PayoutNwcClient = Pick<NWCClient, "payInvoice" | "lookupInvoice" | "close">;

const pending: PayoutOutcome = { status: "pending" };
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Dedicated outbound client: never retries pay_invoice, including relay failures. */
export function createNwcPayout(options: {
  uri?: () => string | undefined;
  clientFactory?: (uri: string) => PayoutNwcClient;
  timeoutMs?: number;
} = {}): NwcPayout {
  const uri = options.uri ?? (() => process.env.NWC_URI);
  const factory = options.clientFactory ?? ((value: string) =>
    new NWCClient({ nostrWalletConnectUrl: value, logger: silentLogger }));
  const configured = () => {
    if (process.env.NODE_ENV === "test" && !options.clientFactory) return false;
    try {
      const value = uri();
      if (!value) return false;
      const parsed = new URL(value);
      return parsed.protocol === "nostr+walletconnect:" &&
        /^[0-9a-f]{64}$/i.test(parsed.hostname) &&
        /^[0-9a-f]{64}$/i.test(parsed.searchParams.get("secret") ?? "") &&
        parsed.searchParams.getAll("relay").length > 0 &&
        parsed.searchParams.getAll("relay").every(relay => {
          const url = new URL(relay);
          return url.protocol === "wss:" && !url.username && !url.password;
        });
    } catch { return false; }
  };
  function preimageEvidence(value: unknown, invoice: YieldWithdrawalInvoice): PayoutOutcome {
    if (!value || typeof value !== "object") return pending;
    const preimage = (value as { preimage?: unknown }).preimage;
    if (typeof preimage !== "string" || !/^[0-9a-f]{64}$/i.test(preimage) ||
        createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== invoice.paymentHash) return pending;
    // NIP-47 has no Coinos REST UID. Keep the existing storage/wire field,
    // using the Lightning payment hash as its stable transaction identifier.
    return { status: "settled", txid: invoice.paymentHash, preimage: preimage.toLowerCase() };
  }
  async function execute(
    operation: (client: PayoutNwcClient) => Promise<PayoutOutcome>,
  ): Promise<PayoutOutcome> {
    if (!configured()) return pending;
    let client: PayoutNwcClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client = factory(uri()!);
      return await Promise.race([
        operation(client),
        new Promise<PayoutOutcome>(resolve => {
          timer = setTimeout(() => resolve(pending), options.timeoutMs ?? 65_000);
        }),
      ]);
    } catch { return pending; }
    finally {
      clearTimeout(timer);
      try { client?.close(); } catch { /* Closing cannot alter financial state. */ }
    }
  }
  return {
    configured,
    pay: (invoiceText, invoice) => execute(async client => {
      try {
        return preimageEvidence(await client.payInvoice({ invoice: invoiceText }), invoice);
      } catch (error) {
        // Only a request-correlated wallet rejection proves this attempt failed.
        // INTERNAL, OTHER, PAYMENT_FAILED, transport/publish errors and timeouts
        // are deliberately inconclusive. Never interpret messages as evidence.
        if (error instanceof Nip47WalletError &&
            ["INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "NOT_IMPLEMENTED"]
              .includes(error.code)) {
          return { status: "failed", code: "NWC_" + error.code };
        }
        return pending;
      }
    }),
    lookup: invoice => execute(async client => {
      const row = await client.lookupInvoice({ payment_hash: invoice.paymentHash });
      if (!row || row.type !== "outgoing" || row.payment_hash !== invoice.paymentHash ||
          !Number.isSafeInteger(row.amount) || BigInt(row.amount) !== invoice.amountMsats ||
          row.state !== "settled") return pending;
      const proof = preimageEvidence(row, invoice);
      if (proof.status === "settled") return proof;
      // An authenticated outgoing terminal record also proves settlement when
      // the wallet omits its preimage. A present but invalid proof fails closed.
      if (!row.preimage && Number.isSafeInteger(row.settled_at) && row.settled_at > 0) {
        return { status: "settled", txid: invoice.paymentHash };
      }
      // Missing records or failed records from an older same-invoice attempt
      // can never release the current reservation.
      return pending;
    }),
  };
}
