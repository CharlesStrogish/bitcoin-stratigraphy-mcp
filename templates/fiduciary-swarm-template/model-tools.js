import { tool } from "@langchain/core/tools";

// Deliberately exclude settlement, clearing, notarization and other write tools.
export const READ_ONLY_TOOLS = new Set([
  "stratigraphy.list",
  "stratigraphy.get",
  "stratigraphy.get_digest",
  "stratigraphy.get_diff",
  "stratigraphy.get_range",
  "payment.get_info",
]);

/** A payment preimage is a spend credential, not model context. */
export function modelReceipt(receipt) {
  if (!receipt || receipt.provenance_verified !== true || !("payload" in receipt)) {
    throw new Error("UNVERIFIED_TOOL_RECEIPT");
  }
  return JSON.stringify({
    payload: receipt.payload,
    provenance_verified: true,
    payload_sha256: receipt.payload_sha256,
    thermodynamic_cost: receipt.thermodynamic_cost,
    timestamp: receipt.timestamp,
    timestamp_kind: receipt.timestamp_kind,
    evidence_scope: receipt.evidence_scope,
  });
}

/** Retain the SDK's native LangChain adapters, adding a model-safe output boundary. */
export function modelSafeTools(connected) {
  const allowed = new Set(connected.fiduciary.openAITools
    .filter((_, index) => READ_ONLY_TOOLS.has(connected.fiduciary.tools[index].name))
    .map((descriptor) => descriptor.function.name));
  const tools = connected.tools.filter((entry) => allowed.has(entry.name)).map((entry) =>
    tool(async (args) => modelReceipt(await entry.invoke(args)), {
      name: entry.name,
      description: entry.description,
      schema: entry.schema,
    }),
  );
  if (!tools.length) throw new Error("NO_READ_ONLY_MCP_TOOLS_DISCOVERED");
  return tools;
}
