import { batchSettlement } from "./batch-settlement";
import { licensingCompliance } from "./licensing-compliance";

/** Shared by actual MCP payment gates, payment discovery, and HTTP cost quotes. */
export const mcpToolPrices = Object.freeze({
  "stratigraphy.get": 250,
  "stratigraphy.get_digest": 250,
  "stratigraphy.get_diff": 250,
  "stratigraphy.get_range": 250,
  "stratigraphy.list": 0,
  "proof.attenuate": 250,
  "proof.verify": 250,
  "proof.get_by_hash": 250,
  "proof.list": 0,
  "proof.submit": 250,
  "proof.notarize": 250,
  "proof.ground": 250,
  "mesh.get_status": 250,
  "mesh.broadcast": 250,
  "payment.get_info": 250,
  "workflow.audit_trajectory": 250,
});

export const MCP_INVOICE_EXPIRY_SECONDS = 3600;

export const legacyToolNames = {
  "stratigraphy.latest": "stratigraphy.list",
  "proof.status": "proof.list",
  "payment.info": "payment.get_info",
  "stratigraphy.digest": "stratigraphy.get_digest",
  "stratigraphy.diff": "stratigraphy.get_diff",
  "stratigraphy.range": "stratigraphy.get_range",
  "mesh.status": "mesh.get_status",
} as const;

export function canonicalToolName(name: string): string {
  return Object.hasOwn(legacyToolNames, name)
    ? legacyToolNames[name as keyof typeof legacyToolNames]
    : name;
}

/** The name itself, its canonical name, and every legacy alias of that operation. */
export function equivalentToolNames(name: string): string[] {
  const canonical = canonicalToolName(name);
  return [
    ...new Set([
      name,
      canonical,
      ...Object.entries(legacyToolNames)
        .filter(([, target]) => target === canonical)
        .map(([legacy]) => legacy),
    ]),
  ];
}

// These selectors describe existing operations; they are NOT callable MCP aliases.
const pricingSelectors = {
  "stratigraphy.get_latest": "stratigraphy.get",
  "proof.verify_zk_proof": "proof.verify",
} as const;

export function quoteMcpTools(tools: string[]) {
  const items = tools.map((tool) => {
    const canonical = Object.hasOwn(pricingSelectors, tool)
      ? pricingSelectors[tool as keyof typeof pricingSelectors]
      : canonicalToolName(tool);
    if (!Object.hasOwn(mcpToolPrices, canonical)) {
      throw new RangeError("Unknown MCP tool or pricing selector");
    }
    const priceSats = mcpToolPrices[canonical as keyof typeof mcpToolPrices];
    // Existing executable aliases retain their original paid credential scope.
    const executionTool = Object.hasOwn(legacyToolNames, tool)
      ? tool
      : canonical;
    return {
      tool,
      canonical_tool: canonical,
      price_sats: priceSats,
      payment_required: priceSats > 0,
      invoice_generation:
        priceSats > 0
          ? {
              method: "POST" as const,
              endpoint: "/mcp",
              jsonrpc_method: "tools/call" as const,
              tool: executionTool,
              amount_sats: priceSats,
              description: `Bitcoin Stratigraphy MCP ${executionTool} execution`,
              scope_path: `/mcp/tools/${executionTool}`,
              expiry_seconds: MCP_INVOICE_EXPIRY_SECONDS,
            }
          : null,
    };
  });
  return {
    protocol: "L402" as const,
    licensing_compliance: licensingCompliance,
    batchSettlement,
    currency: "sats" as const,
    perToolSats: Object.fromEntries(
      items.map((item) => [item.tool, item.price_sats]),
    ),
    items,
    total_sats: items.reduce((total, item) => total + item.price_sats, 0),
    l402: {
      settlement_asset: "btc-lightning" as const,
      invoice_generated: false,
      aggregate_invoice_supported: false,
      invoice_expiry_seconds: MCP_INVOICE_EXPIRY_SECONDS,
      generation_trigger:
        "An unauthenticated tools/call to a paid tool generates its own invoice; include that tool's required arguments.",
      challenge_status: 402,
      challenge_header: "WWW-Authenticate",
      challenge_format: 'L402 macaroon="<macaroon>", invoice="<BOLT11>"',
      challenge_body_fields: [
        "macaroon",
        "invoice",
        "payment_hash",
        "amount_sats",
      ],
      authorization_format: "L402 <macaroon>:<preimage>",
      credential_scope: "exact MCP tool path",
      max_requests: 1,
      batch: {
        request_header: "X-L402-Batch-Size",
        header_value: "100",
        max_requests: 100,
        price_multiplier: 100,
        credential_scope: "exact MCP tool path",
      },
    },
  };
}
