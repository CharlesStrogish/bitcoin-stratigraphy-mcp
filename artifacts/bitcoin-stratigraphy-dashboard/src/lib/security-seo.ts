// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { pageUrl } from "./site";

export const SECURITY_TITLE = "Security Attestation | Bitcoin Stratigraphy";
export const SECURITY_DESCRIPTION =
  "Review Bitcoin Stratigraphy's historical 1,064-test audit report, evidence hashes, L402 spend controls, Ed25519 receipts, and NIP-98 authentication scope.";
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
