// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
/** Same-tool macro-passes and ordered cross-tool pipelines are distinct transports. */
export const batchSettlement = Object.freeze({
  protocol: "L402",
  settlementAsset: "btc-lightning",
  requestHeader: "X-L402-Batch-Size",
  supportedBatchSizes: [1, 100, 1000, 10000],
  exampleHeaderValue: "100",
  maxCalls: 10000,
  priceMultiplier: 100,
  credentialScope: "exact MCP tool path",
  invoiceGeneratedByDiscovery: false,
  pipeline: {
    methods: ["tools/pipeline", "tools/batch"],
    callsParameter: "params.calls",
    legacyJsonRpcArrays: true,
    maxSteps: 100,
    pricing: "sum of all ordered per-tool prices, including duplicates",
    referenceSyntax: '{"$ref":"0#/structuredContent/field"}',
    credentialScope: "SHA-256 commitment to the exact pipeline request",
    maxExecutionsPerInvoice: 1,
    execution: "sequential, fail-fast; external side effects are not rolled back",
    receipt: "one signed Article 12 record-keeping receipt, persisted in PostgreSQL",
  },
  instructions:
    "For a same-tool pass, POST tools/call with X-L402-Batch-Size set to exactly 1, 100, 1000 or 10000 and pay its 250-sats-per-call invoice once. Unsupported values return 400. For an ordered cross-tool pipeline, POST tools/pipeline with params.calls (or a legacy JSON-RPC tools/call array), without X-L402-Batch-Size. Pay the exact summed-price invoice once and retry the identical body with Authorization: L402 <macaroon>:<preimage>. Earlier results may be referenced with $ref. Each pipeline invoice executes at most once; expiry, revocation, identity, exact request scope and inherited quotas remain enforced. Discovery never creates an invoice.",
});
