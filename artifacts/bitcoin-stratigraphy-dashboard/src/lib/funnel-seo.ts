import { pageUrl } from "./site";

export const FUNNEL_PAGES = [
  {
    path: "developers",
    title: "BitcoinStratigraphy MCP Server | L402 Agentic Payments",
    description:
      "Integrate autonomous Lightning Network micropayments and Article 12 compliance into your AI swarms via our open-source MCP server.",
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
