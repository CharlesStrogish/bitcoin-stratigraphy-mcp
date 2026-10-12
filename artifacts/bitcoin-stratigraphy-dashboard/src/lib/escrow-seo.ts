// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
export const SIMULATOR_TITLE =
  "Enterprise Swarm Control Room | Bitcoin Stratigraphy Simulator";
export const SIMULATOR_DESCRIPTION =
  "Browser-only synthetic simulation: 50 agents, 1000 traces, a rolling RFC 6962 Merkle tree with real SHA-256, selective-disclosure inclusion proofs, and a simulated proof.notarize anchor. No payment, no Bitcoin.";
export const SIMULATOR_URL =
  "https://bitcoin-stratigraphy-dashboard.replit.app/simulator";

export const ESCROW_APPLICATION = {
  "@type": "SoftwareApplication",
  "@id": "https://bitcoin-stratigraphy-dashboard.replit.app/#escrow-oracle",
  name: "Autonomous Proof-of-Execution Escrow Oracle (L402 + RFC 6962)",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Web",
  url: SIMULATOR_URL,
  description:
    "Autonomous agent escrow with NWC-backed Lightning toll settlement and RFC 6962 execution commitments. The terminal withholds final receipts and escrow preimages until the server confirms payment. Bounty funding and Bitcoin anchoring are separate.",
  author: { "@type": "Person", name: "Charles R. Strogish" },
  license: [
    "https://www.gnu.org/licenses/agpl-3.0.html",
    "https://bitcoin-stratigraphy-dashboard.replit.app/enterprise",
  ],
};
