import { pageUrl } from "./site";

export const FUNNEL_PAGES = [
  {
    path: "developers",
    title: "BitcoinStratigraphy MCP Server | L402 Agentic Payments",
    description:
      "AI failover protocols and LLM disaster recovery for enterprise swarms: integrate native Lightning continuity, L402 payments and 19 MCP tools with Bitcoin Stratigraphy.",
    url: pageUrl("/developers"),
  },
  {
    path: "audit",
    title: "AI Article 12 Compliance Audit | ZK-Indemnity",
    description:
      "Run an instant, cryptographically verified EU AI Act compliance scan on your enterprise AI prompts using Lightning Network settlement.",
    url: pageUrl("/audit"),
  },
] as const;
