// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
/** Discovery describes the existing gate; it does not enable new batch sizes. */
export const batchSettlement = Object.freeze({
  protocol: "L402",
  settlementAsset: "btc-lightning",
  requestHeader: "X-L402-Batch-Size",
  supportedBatchSizes: [100],
  exampleHeaderValue: "100",
  maxCalls: 100,
  priceMultiplier: 100,
  credentialScope: "exact MCP tool path",
  invoiceGeneratedByDiscovery: false,
  instructions:
    "On the initial POST /mcp tools/call to a paid tool, include X-L402-Batch-Size: 100 and the tool's required arguments. Receive HTTP 402 with one upfront Lightning invoice priced at 100 times the per-call price and an invoice-bound multi-call macro-macaroon. Pay that exact invoice once, then reuse Authorization: L402 <macaroon>:<preimage> for up to 100 calls to the same tool. Positive payment-proof caching avoids per-call Lightning settlement latency; every call still enforces expiry, revocation, attenuation and inherited quotas. No cross-tool aggregate invoice or arbitrary 10–1000 size range is supported.",
});
