// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { LICENSING_EMAIL } from "./site";

/** API path, relative to the artifact base URL. */
export const DUE_DILIGENCE_BRIEF_PATH = "api/v1/enterprise/due-diligence-brief";
export const CISO_INTAKE_SUBJECT =
  "Commercial Exemption License Inquiry — Bitcoin Stratigraphy Data Engine";

/** Mirrors the API brief's questionnaire; a regression test compares both. */
export const CISO_INTAKE_QUESTIONNAIRE = [
  {
    id: "swarm_scale",
    number: 1,
    topic: "Swarm Scale",
    question:
      "How many autonomous agents or swarm nodes will call the engine, across how many teams or environments?",
  },
  {
    id: "event_throughput",
    number: 2,
    topic: "Event Throughput",
    question:
      "What sustained and peak volume of logged events, notarizations or MCP tool calls do you expect per day?",
  },
  {
    id: "target_infrastructure",
    number: 3,
    topic: "Target Infrastructure (VPC vs. Air-Gapped Bare Metal)",
    question:
      "Will you deploy in a private cloud VPC or on air-gapped bare metal, and what network egress, if any, is permitted?",
  },
  {
    id: "regulatory_retention_scope",
    number: 4,
    topic:
      "Regulatory & EU AI Act Article 12 / Article 26(6) 6-Month Retention Scope",
    question:
      "Which AI systems and event logs are in scope, and must logs be retained for at least six months or longer under other applicable law?",
  },
  {
    id: "in_house_stewardship",
    number: 5,
    topic: "In-House Technical Stewardship",
    question:
      "Which independently verifiable receipt exports and issuer-key rotation controls will your organization operate in-house?",
  },
] as const;

/** Plain-text intake template; mailto bodies use CRLF line breaks. */
export function cisoIntakeTemplate(lineBreak = "\n"): string {
  return [
    "=== BITCOIN STRATIGRAPHY: CISO INTAKE TEMPLATE ===",
    "Free, centralized APIs carry maximum cross-vendor liability.",
    "The only engine providing mathematically non-repudiable Article 12 Flight Recorders, shifting liability off the enterprise.",
    "",
    "Internal due-diligence worksheet only. AGPLv3 Commercial Copyright Waivers are purchased self-serve at https://bitcoinstratigraphy.com/#enterprise-licensing; no custom quote or negotiation is offered.",
    "",
    "Enterprise / Organization Name:",
    "",
    "Primary AI Use Case & Estimated Swarm Size (Number of Active Agents):",
    "",
    "Target Deployment Environment (e.g., On-Prem, Private VPC, Air-Gapped):",
    "",
    "What specific regulatory frameworks (e.g., EU AI Act Article 12, SOC 2 Type II, FINRA) govern your internal AI swarm's telemetry and data retention requirements?",
    "",
    "Selected waiver tier (swarm_monthly $2,500 / swarm_annual $25,000 / global_monthly $25,000 / global_annual $250,000, quoted in BTC):",
    "",
    "[ ] All prepaid MCP Macro-Macaroons, Scanner Packs, and AGPLv3 Commercial Copyright Waivers are 100% self-serve and provided STRICTLY AS-IS, WITH ALL FAULTS. Zero SLAs, zero uptime warranties, zero indemnity, zero custom MSAs, zero vendor questionnaires, and zero support obligations. Full source code is publicly inspectable under AGPLv3 for independent self-hosting. Payment for a Commercial Copyright Waiver strictly grants a time-locked, non-negotiable waiver from AGPLv3 Section 13 network source-disclosure requirements for the specified term, anchored cryptographically to your confirmed Bitcoin transaction.",
  ].join(lineBreak);
}

export const CISO_MAILTO_HREF = `mailto:${LICENSING_EMAIL}?subject=${encodeURIComponent(CISO_INTAKE_SUBJECT)}&body=${encodeURIComponent(cisoIntakeTemplate("\r\n"))}`;

/** Exact intake block for clipboard and manual-copy fallback. */
export const CISO_INTAKE_COPY_TEXT = cisoIntakeTemplate();
