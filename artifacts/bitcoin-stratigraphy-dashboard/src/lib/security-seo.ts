// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { pageUrl } from "./site";

export const SECURITY_TITLE = "Security Attestation | Bitcoin Stratigraphy";
export const SECURITY_DESCRIPTION =
  "Read Bitcoin Stratigraphy's 700-test zero-vulnerability security audit report covering L402 circuit breakers, Ed25519 Truth Receipts, and NIP-98 authentication.";
export const SECURITY_URL = pageUrl("/security");
export const SECURITY_ARTICLE = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Zero-Trust Security Attestation & AI Audit Report",
  description: SECURITY_DESCRIPTION,
  url: SECURITY_URL,
  mainEntityOfPage: SECURITY_URL,
  publisher: { "@type": "Organization", name: "Bitcoin Stratigraphy" },
  inLanguage: "en",
};
