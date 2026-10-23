// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { ESCROW_GENESIS } from "../services/escrowGenesis";
import { mcpToolPrices } from "./mcp-pricing";
import {
  CANONICAL_ORIGIN,
  COMMERCIAL_LICENSE_PRICE,
  CREATOR,
  LICENSING_EMAIL,
  NPM_PACKAGE,
  NPX_COMMAND,
  PRODUCT_NAME,
  RELEASE_VERSION,
  canonicalUrl,
} from "./public-site";

export const DUE_DILIGENCE_BRIEF_PATH =
  "/api/v1/enterprise/due-diligence-brief";
export const DUE_DILIGENCE_BRIEF_FILENAME =
  "bitcoin-stratigraphy-ciso-due-diligence-brief.json";
export const CISO_INTAKE_SUBJECT =
  "Commercial Exemption License Inquiry — Bitcoin Stratigraphy Data Engine";

/** The dashboard keeps an identical copy; a regression test compares both. */
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
    `${PRODUCT_NAME} — CISO Intake Questionnaire`,
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
    `Due-diligence brief: ${canonicalUrl(DUE_DILIGENCE_BRIEF_PATH)}`,
  ].join(lineBreak);
}

export function cisoIntakeMailto(): string {
  return `mailto:${LICENSING_EMAIL}?subject=${encodeURIComponent(CISO_INTAKE_SUBJECT)}&body=${encodeURIComponent(cisoIntakeTemplate("\r\n"))}`;
}

const toolNames = Object.keys(mcpToolPrices) as Array<
  keyof typeof mcpToolPrices
>;

/** Executive summary for vendor review; the executed agreement governs. */
export const enterpriseDueDiligenceBrief = {
  document: "CISO Due-Diligence Brief",
  schema_version: "1.0.0",
  product: PRODUCT_NAME,
  release_version: RELEASE_VERSION,
  canonical_url: CANONICAL_ORIGIN,
  brief_url: canonicalUrl(DUE_DILIGENCE_BRIEF_PATH),
  publisher: {
    name: CREATOR.name,
    role: CREATOR.role,
    licensing_contact: LICENSING_EMAIL,
  },
  executive_summary:
    'The public engine is AGPLv3 software. Organizations that cannot meet AGPLv3 source-disclosure obligations for a covered deployment can obtain a Commercial Enterprise Exemption License, delivered "AS IS" for self-hosted and air-gapped operation with zero external SLAs and in-house technical stewardship.',
  licensing: {
    spdx: "(AGPL-3.0-only OR LicenseRef-Commercial)",
    agpl_copyleft_scope: {
      license: "AGPL-3.0-only",
      summary:
        "AGPLv3 is a strong copyleft license. Conveying the engine or a work based on it requires making the complete Corresponding Source of that work available under AGPLv3.",
      network_use:
        "Section 13: if you modify the engine and users interact with your modified version over a network, you must offer those users its Corresponding Source under AGPLv3.",
      boundaries:
        "AGPLv3 does not automatically cover independent programs that only exchange data with the engine over HTTP or MCP, or model weights trained separately. Combining engine code into your own codebase can bring that combined work within its terms; confirm your architecture with counsel.",
    },
    commercial_exemption: {
      name: "Commercial Enterprise Exemption License",
      price: COMMERCIAL_LICENSE_PRICE,
      grant:
        "An executed commercial agreement exempts the licensee's covered deployment and modifications from AGPLv3 source-disclosure obligations. API fees and payment credentials do not purchase a software license.",
      delivery:
        '"AS IS" self-hosted delivery for installation on licensee-controlled private or air-gapped infrastructure.',
      service_levels:
        "Zero external SLAs: no uptime, availability, response-time, support or maintenance commitments.",
      technical_stewardship:
        "The licensee's own staff install, operate, monitor, patch, back up and secure the deployment.",
      settlement:
        "Enterprise pricing is customized by swarm size and deployment needs, settled via a single Bitcoin transaction paid in full at the time of execution.",
      contact: LICENSING_EMAIL,
    },
  },
  architecture: {
    deployment_model:
      '"AS IS" self-hosted engine operated inside the licensee\'s VPC or on air-gapped bare metal; no vendor-hosted control plane is required.',
    air_gap_boundaries: [
      {
        component: "Bitcoin telemetry",
        network_requirement:
          "None when configured for a local Bitcoin Core node. Fiat price-derived metrics are unavailable without a permitted price source and are not fabricated.",
      },
      {
        component: "Event logging and Merkle commitments",
        network_requirement:
          "None. RFC 6962 commitments and retained logs are written to licensee-controlled storage.",
      },
      {
        component: "Public Bitcoin anchoring",
        network_requirement:
          "Governed export and import only. Evidence digests leave the enclave under the licensee's change control; isolated devices never connect directly to mainnet.",
      },
      {
        component:
          "OpenTimestamps calendars, Nostr relays and Lightning wallets",
        network_requirement:
          "Optional external services. Disable them, or route them through approved egress, to keep the deployment fully isolated.",
      },
    ],
  },
  external_sla_policy:
    "No external service levels are offered. Availability, incident response, patching cadence and data recovery are the licensee's responsibility.",
  eu_ai_act: {
    articles: ["Article 12", "Article 26(6)"],
    article_12:
      "High-risk AI systems must technically allow the automatic recording of events (logs) over the lifetime of the system.",
    article_26_6:
      "Deployers keep the logs automatically generated by a high-risk AI system, to the extent those logs are under their control, for a period appropriate to its intended purpose of at least six months, unless applicable Union or national law provides otherwise.",
    retention_alignment:
      "The engine records agent events into tamper-evident Merkle commitments that the licensee can retain on its own storage for six months or longer.",
    deployer_responsibility:
      "Tamper-evident logs support reconstruction; they do not establish compliance, fault or certification. Classification, retention periods and conformity remain the deployer's determination with counsel.",
  },
  genesis_proof: {
    escrow_id: ESCROW_GENESIS.create_response.escrow_id,
    merkle_root: ESCROW_GENESIS.settle_response.merkle_root,
    settled_at_strata_block:
      ESCROW_GENESIS.settle_response.article_12_receipt.settled_at_strata_block,
    toll_fee_sats: ESCROW_GENESIS.create_response.toll_fee_sats,
    receipt_url: canonicalUrl("/api/v1/escrow/genesis-receipt"),
    description:
      "The operator's historical 24-sat mainnet Lightning settlement and RFC 6962 execution commitment at strata block 971341. It is not an on-chain Bitcoin transaction or an OpenTimestamps confirmation.",
  },
  mcp_catalog: {
    tool_count: toolNames.length,
    tools: toolNames,
    free_tools: toolNames.filter((name) => mcpToolPrices[name] === 0),
    prices_sats: mcpToolPrices,
    npm_package: NPM_PACKAGE,
    command: NPX_COMMAND,
    settlement_paths: ["sha256_preimage", "nwc_lookup"],
  },
  intake: {
    email: LICENSING_EMAIL,
    subject: CISO_INTAKE_SUBJECT,
    mailto: cisoIntakeMailto(),
    questionnaire: CISO_INTAKE_QUESTIONNAIRE,
  },
  disclaimer:
    "Informational summary for vendor due diligence. It is not legal advice, a certification, a statement of conformity or a grant of rights; only an executed commercial agreement grants a license.",
} as const;
