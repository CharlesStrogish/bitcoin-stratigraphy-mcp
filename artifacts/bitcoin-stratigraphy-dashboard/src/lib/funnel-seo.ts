import { pageUrl } from "./site";

export const FUNNEL_PAGES = [
  {
    path: "developers",
    title: "BitcoinStratigraphy MCP Server | L402 Agentic Payments",
    description:
      "AI failover protocols and LLM disaster recovery: Lightning continuity, L402 payments, and 19-tool capacity across 6 namespaces. Discover the host's enabled tools.",
    url: pageUrl("/developers"),
  },
  {
    path: "audit",
    title: "Article 12 Heuristic Prompt Risk Scan | Bitcoin Stratigraphy",
    description:
      "Run a paid keyword-based prompt risk review with a SHA-256 report hash. Results support evidence review, not legal certification, ZK proof, or Bitcoin timestamp.",
    url: pageUrl("/audit"),
  },
] as const;
