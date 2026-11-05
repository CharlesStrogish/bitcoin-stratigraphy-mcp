// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { pageUrl } from "./site";

export const MANIFESTO_TITLE =
  "Bitcoin Stratigraphy | The Global Central Bank for Autonomous AI";
export const MANIFESTO_DESCRIPTION =
  "Explore Bitcoin Stratigraphy's AI platform: L402 spend circuit breakers, Ed25519 Truth Receipts, 21% yield, and Python SDKs for developers and enterprise CISOs.";
export const MANIFESTO_URL = pageUrl("/manifesto");
export const MANIFESTO_ARTICLE = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline:
    "The Global Central Bank for Autonomous AI: Securing Agent Swarms with L402 Circuit Breakers and Cryptographic Truth",
  description: MANIFESTO_DESCRIPTION,
  url: MANIFESTO_URL,
  mainEntityOfPage: MANIFESTO_URL,
  author: { "@type": "Person", name: "Charles R. Strogish" },
  publisher: { "@type": "Organization", name: "Bitcoin Stratigraphy" },
  inLanguage: "en",
};
