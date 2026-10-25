// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
export const wholesaleSubVending = {
  supported: true,
  batchHeader: "X-L402-Batch-Size",
  batchSize: 100,
  purchase: "Purchase one tool-scoped 100-call Macro-Macaroon using L402.",
  attenuationTool: "proof.attenuate",
  childCaveats: ["delegate_pubkey = <64 lowercase hex>", "rpc = tool.name", "time < YYYY-MM-DDTHH:MM:SS.sssZ", "max_requests=1"],
  redemption: "Supply the child macaroon, original invoice payment proof and a fresh body-bound NIP-98 signature from the delegated key.",
  accounting: "Every inherited quota and delegated ancestor revocation is checked. Invoice-bound programmatic L402 revenue sharing stays with the original invoice allocation.",
} as const;
