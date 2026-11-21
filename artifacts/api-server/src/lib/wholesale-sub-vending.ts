// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
export const wholesaleSubVending = {
  supported: true,
  batchHeader: "X-L402-Batch-Size",
  batchSize: 100,
  purchase: "Purchase a tool-scoped 1/100/1000/10000-call Macro-Macaroon using L402 with X-L402-Batch-Size set to exactly 1, 100, 1000 or 10000; at 250 sats/call the respective prices are 250 / 25,000 / 250,000 / 2,500,000 sats. batchSize is a 100-call example, not the maximum.",
  attenuationTool: "proof.attenuate",
  childCaveats: ["delegate_pubkey = <64 lowercase hex>", "rpc = tool.name", "time < YYYY-MM-DDTHH:MM:SS.sssZ", "max_requests=1"],
  redemption: "Supply the child macaroon, original invoice payment proof and a fresh body-bound NIP-98 signature from the delegated key.",
  accounting: "Every inherited quota and delegated ancestor revocation is checked. Invoice-bound programmatic L402 revenue sharing stays with the original invoice allocation.",
} as const;
