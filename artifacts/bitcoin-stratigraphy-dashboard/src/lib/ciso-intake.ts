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
      "Which Automated Compliance SLAs do you require for signed revocation snapshot exports, issuer-key rotation, and in-house deployment stewardship?",
  },
] as const;

/** Plain-text intake template; mailto bodies use CRLF line breaks. */
export function cisoIntakeTemplate(lineBreak = "\n"): string {
  return [
    "=== BITCOIN STRATIGRAPHY: CISO INTAKE TEMPLATE ===",
    "Free, centralized APIs carry maximum cross-vendor liability.",
    "The only engine providing mathematically non-repudiable Article 12 Flight Recorders, shifting liability off the enterprise.",
    "",
    "To request a custom Tier II Commercial Enterprise Exemption quote, please complete the following and email to: licensing@bitcoinstratigraphy.com",
    "",
    "Enterprise / Organization Name:",
    "",
    "Primary AI Use Case & Estimated Swarm Size (Number of Active Agents):",
    "",
    "Target Deployment Environment (e.g., On-Prem, Private VPC, Air-Gapped):",
    "",
    "What specific regulatory frameworks (e.g., EU AI Act Article 12, SOC 2 Type II, FINRA) govern your internal AI swarm's telemetry and data retention requirements?",
    "",
    "Do you require standard self-managed cryptographic audits, or are you inquiring about our Automated Compliance SLAs for continuous, machine-generated audit reporting?",
    "",
    "[ ] We acknowledge the base Tier II Commercial Enterprise Exemption starts at $250k/annual, with Automated Compliance SLAs scoped separately based on regulatory requirements.",
  ].join(lineBreak);
}

export const CISO_MAILTO_HREF = `mailto:${LICENSING_EMAIL}?subject=${encodeURIComponent(CISO_INTAKE_SUBJECT)}&body=${encodeURIComponent(cisoIntakeTemplate("\r\n"))}`;

/** Exact intake block for clipboard and manual-copy fallback. */
export const CISO_INTAKE_COPY_TEXT = cisoIntakeTemplate();
