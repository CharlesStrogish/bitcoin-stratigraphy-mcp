import { parse } from "yaml";
import openApiSource from "../../../lib/api-spec/openapi.yaml";
import { mcpToolPrices } from "./lib/mcp-pricing";
import { primaryStratigraphyContracts } from "./services/primaryStratigraphySchemas";
import { mcpToolDefinitions } from "./routes/mcp";

export const openApiDocument = parse(openApiSource) as Record<string, unknown>;
const tools = openApiDocument["x-mcp-tools"] as Record<
  string,
  { annotations?: Record<string, unknown> }
>;
for (const [name, amountSats] of Object.entries(mcpToolPrices)) {
  tools[name].annotations = {
    ...tools[name].annotations,
    l402: {
      amountSats,
      ...(amountSats > 0
        ? { batchSize: 100, batchHeader: "X-L402-Batch-Size" }
        : {}),
    },
  };
}
// The canonical 15-tool registry owns these live data contracts. Keep the
// public OpenAPI extension in sync without adding any additional MCP tools.
for (const [name, contract] of Object.entries(primaryStratigraphyContracts)) {
  Object.assign(tools[name], contract);
  Object.assign(tools[name], {
    inputSchema: mcpToolDefinitions.find((tool) => tool.name === name)?.inputSchema,
  });
  if (name === "stratigraphy.get") delete tools[name].annotations?.zkProof;
}
