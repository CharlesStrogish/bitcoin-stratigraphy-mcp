import { parse } from "yaml";
import openApiSource from "../../../lib/api-spec/openapi.yaml";
import { mcpToolPrices } from "./lib/mcp-pricing";

export const openApiDocument = parse(openApiSource) as Record<string, unknown>;
const tools = openApiDocument["x-mcp-tools"] as Record<string, { annotations?: Record<string, unknown> }>;
for (const [name, amountSats] of Object.entries(mcpToolPrices)) {
  tools[name].annotations = {
    ...tools[name].annotations,
    l402: { amountSats, ...(amountSats > 0 ? { batchSize: 100, batchHeader: "X-L402-Batch-Size" } : {}) },
  };
}