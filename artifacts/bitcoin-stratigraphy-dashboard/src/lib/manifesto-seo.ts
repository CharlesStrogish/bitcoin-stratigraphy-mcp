// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { pageUrl } from "./site";

export const MANIFESTO_TITLE =
  "Bitcoin Stratigraphy | Non-Custodial L402 Notary for AI";
export const MANIFESTO_DESCRIPTION =
  "Explore non-custodial L402 notarization, Bitcoin state anchoring, Ed25519 receipts, spend controls, and programmatic Agent Yield credits for autonomous AI.";
export const MANIFESTO_URL = pageUrl("/manifesto");
export const MANIFESTO_ARTICLE = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline:
    "Non-Custodial L402 Notarization for Autonomous AI: Securing Agent Swarms with Spend Controls and Verifiable Receipts",
  description: MANIFESTO_DESCRIPTION,
  url: MANIFESTO_URL,
  mainEntityOfPage: MANIFESTO_URL,
  author: { "@type": "Person", name: "Charles R. Strogish" },
  publisher: { "@type": "Organization", name: "Bitcoin Stratigraphy" },
  inLanguage: "en",
};
