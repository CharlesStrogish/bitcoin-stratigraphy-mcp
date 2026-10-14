// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { COMMERCIAL_LICENSE_PRICE, LICENSING_EMAIL, siteUrl } from "./site";

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
      'Do you confirm that your team will install, operate, patch and secure the engine in-house under strict "AS IS" terms with no SLAs? (Yes/No)',
  },
] as const;

/** Plain-text intake template; mailto bodies use CRLF line breaks. */
export function cisoIntakeTemplate(lineBreak = "\n"): string {
  return [
    "Bitcoin Stratigraphy Data Engine — CISO Intake Questionnaire",
    `Commercial Enterprise License (${COMMERCIAL_LICENSE_PRICE})`,
    "",
    "Organization:",
    "Contact name and title:",
    "",
    ...CISO_INTAKE_QUESTIONNAIRE.flatMap((item) => [
      `${item.number}. ${item.topic}: ${item.question}`,
      "Answer:",
      "",
    ]),
    `Due-diligence brief: ${siteUrl(`/${DUE_DILIGENCE_BRIEF_PATH}`)}`,
  ].join(lineBreak);
}

export const CISO_MAILTO_HREF = `mailto:${LICENSING_EMAIL}?subject=${encodeURIComponent(CISO_INTAKE_SUBJECT)}&body=${encodeURIComponent(cisoIntakeTemplate("\r\n"))}`;

/** Copyable version for webmail users, with the recipient and subject first. */
export const CISO_INTAKE_COPY_TEXT = [
  `To: ${LICENSING_EMAIL}`,
  `Subject: ${CISO_INTAKE_SUBJECT}`,
  "",
  cisoIntakeTemplate(),
].join("\n");
