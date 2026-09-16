export type SettlementInvoiceInput = {
  amountMsats: number;
  description: string;
  expirySeconds: number;
  signal?: AbortSignal;
};

export type SettlementInvoice = {
  invoice: string;
  paymentHash: string;
  provider: string;
};

export type SettlementVerificationInput = {
  paymentHash: string;
  preimage: string;
  expectedAmountMsats: number;
  expectedDescription: string;
  signal?: AbortSignal;
};

export type SettlementVerification =
  | { settledAt: number; provider: string }
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