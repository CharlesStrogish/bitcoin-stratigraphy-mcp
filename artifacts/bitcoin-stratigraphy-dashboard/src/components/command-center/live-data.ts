// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useQuery } from "@tanstack/react-query";
import {
  quoteMcpToolCosts,
  type McpBatchCostQuoteL402Batch,
} from "@workspace/api-client-react";
import { CANONICAL_MCP_TOOL_NAMES } from "./catalog";

export interface McpToolQuote {
  prices: ReadonlyMap<string, number>;
  authorizationFormat: string;
  batch: McpBatchCostQuoteL402Batch | null;
}

/** Free price discovery: POST /api/v1/cost never creates an invoice. */
export function useMcpToolQuote() {
  return useQuery({
    queryKey: ["command-center", "mcp-tool-quote"],
    queryFn: async (): Promise<McpToolQuote> => {
      const quote = await quoteMcpToolCosts({
        tools: [...CANONICAL_MCP_TOOL_NAMES],
      });
      const prices = new Map(
        quote.items.map((item) => [item.canonical_tool, item.price_sats]),
      );
      const missing = CANONICAL_MCP_TOOL_NAMES.filter(
        (name) => !prices.has(name),
      );
      if (missing.length) {
        throw new Error(`The live quote omitted ${missing.join(", ")}`);
      }
      return {
        prices,
        authorizationFormat: quote.l402.authorization_format,
        batch: quote.l402.batch ?? null,
      };
    },
    staleTime: 10 * 60_000,
  });
}
