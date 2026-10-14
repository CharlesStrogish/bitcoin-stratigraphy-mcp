// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { ESCROW_APPLICATION } from "./escrow-seo";
import { siteUrl } from "./site";

export const COMPLIANCE_TITLE =
  "EU AI Act Article 12 Compliance Sandbox | Bitcoin Stratigraphy";
export const COMPLIANCE_DESCRIPTION =
  "Simulate autonomous L402 proof-of-execution and ensure your multi-agent swarms meet EU AI Act Article 12 compliance with RFC 6962 Merkle flight recorders.";
export const COMPLIANCE_URL = siteUrl("/compliance");

export const COMPLIANCE_ARTICLE = {
  "@context": "https://schema.org",
  "@type": "TechArticle",
  headline:
    "EU AI Act Article 12 Compliance Sandbox: Autonomous Proof-of-Execution",
  description: COMPLIANCE_DESCRIPTION,
  url: COMPLIANCE_URL,
  mainEntityOfPage: COMPLIANCE_URL,
  inLanguage: "en",
  about: ESCROW_APPLICATION,
  license: [
    "https://www.gnu.org/licenses/agpl-3.0.html",
    siteUrl("/enterprise"),
  ],
  author: {
    "@type": "Person",
    name: "Charles R. Strogish",
  },
};
