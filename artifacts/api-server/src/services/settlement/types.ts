export const SETTLEMENT_ASSETS = [
  "btc-lightning",
  "l-btc",
  "taproot-assets",
] as const;
export type SettlementAsset = (typeof SETTLEMENT_ASSETS)[number];

export type SettlementInvoiceInput = {
  amountMsats: number;
  description: string;
  expirySeconds: number;
  asset?: SettlementAsset;
  signal?: AbortSignal;
};

export type SettlementInvoice = {
  invoice: string;
  paymentHash: string;
  provider: string;
  asset?: SettlementAsset;
};

export type SettlementVerificationInput = {
  paymentHash: string;
  preimage: string;
  expectedAmountMsats: number;
  expectedDescription: string;
  expectedProvider?: string;
  asset?: SettlementAsset;
  signal?: AbortSignal;
};

export type SettlementVerification =
  | { settledAt: number; provider: string; asset?: SettlementAsset }
  | "invalid"
  | "unavailable";

export interface SettlementProvider {
  readonly name: string;
  isConfigured(): boolean;
  createInvoice(input: SettlementInvoiceInput): Promise<SettlementInvoice>;
  verifyPayment(
    input: SettlementVerificationInput,
  ): Promise<Exclude<SettlementVerification, "unavailable">>;
}

export class SettlementProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
