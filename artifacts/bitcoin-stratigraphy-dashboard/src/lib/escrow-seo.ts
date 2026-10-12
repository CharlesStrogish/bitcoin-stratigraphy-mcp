// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
export const SIMULATOR_TITLE =
  "Enterprise Interactive Preview & Live REST Escrow | Bitcoin Stratigraphy";
export const SIMULATOR_DESCRIPTION =
  "Enterprise Interactive Preview visualizes client-side swarm evidence with SHA-256 and RFC 6962 Merkle proofs. The separate Live REST Escrow terminal executes real Lightning Network micropayments via L402 and Nostr Wallet Connect, with dynamic market toll pricing targeting ~$0.02.";
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
