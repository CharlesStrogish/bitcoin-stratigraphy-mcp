// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { mcpToolDefinitions } from "../routes/mcp";
import { mcpToolPrices } from "./mcp-pricing";
import {
  MCP_NATIVE_PROMPTS,
  MCP_NATIVE_RESOURCES,
} from "./mcp-native-discovery";
import {
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  STATELESS_MCP_PROTOCOL_VERSION,
} from "./mcp-stateless";
import {
  ATTESTATION_DIRECTIVE,
  L402_PREFLIGHT,
  L402_SETTLEMENT_PATHS,
} from "./agent-conversion";
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

const MACRO_BATCH_CALLS = 100;

/** Descriptors mirror the live tools/list registry; they do not register tools. */
const toolDescriptors = mcpToolDefinitions.map((tool) => {
  const priceSats = mcpToolPrices[tool.name as keyof typeof mcpToolPrices];
  return {
    name: tool.name,
    namespace: tool.name.split(".")[0]!,
    title: tool.title,
    description: tool.description,
    price_sats: priceSats,
    payment_required: priceSats > 0,
    ...(priceSats > 0
      ? { batch: { max_calls: MACRO_BATCH_CALLS, header: "X-L402-Batch-Size" } }
      : {}),
    annotations: {
      readOnlyHint: tool.annotations.readOnlyHint,
      destructiveHint: tool.annotations.destructiveHint,
      idempotentHint: tool.annotations.idempotentHint,
      openWorldHint: tool.annotations.openWorldHint,
    },
  };
});

/** Public discovery document; version strings do not configure MCP negotiation. */
export const mcpDiscoveryManifest = {
  $schema: "https://modelcontextprotocol.io/schemas/discovery/v1.json",
  name: "bitcoin-stratigraphy-mcp",
  title: PRODUCT_NAME,
  version: RELEASE_VERSION,
  description:
    "Bitcoin Stratigraphy: 16 canonical MCP tools for the Hal Finney Horizon tracker ($10M / BTC USD price), 15 J/TH thermodynamic energy calculation (hashrate H/s / 1e12 * 15 watts), Sovereign Node Bitcoin Core RPC telemetry, Live L402 Satoshi settlement through configured NWC, and OpenTimestamps provenance. Two sandbox discovery tools are free; paid execution requires verified settlement.",
  canonical_url: CANONICAL_ORIGIN,
  author: {
    name: CREATOR.name,
    role: CREATOR.role,
    url: CANONICAL_ORIGIN,
  },
  contact: {
    licensing: LICENSING_EMAIL,
  },
  homepage: CANONICAL_ORIGIN,
  origin: CANONICAL_ORIGIN,
  publisher: CANONICAL_ORIGIN,
  documentation: canonicalUrl("/docs"),
  links: {
    documentation: canonicalUrl("/docs"),
    cookbooks: canonicalUrl("/cookbooks"),
    python_sdk: canonicalUrl("/cookbooks/l402_client.py"),
    pricing: canonicalUrl("/api/v1/cost"),
    llms_txt: canonicalUrl("/llms.txt"),
    llms_full_txt: canonicalUrl("/llms-full.txt"),
    openapi: canonicalUrl("/openapi.json"),
    server_card: canonicalUrl("/.well-known/mcp/server-card.json"),
    genesis_receipt: canonicalUrl("/api/v1/escrow/genesis-receipt"),
    due_diligence_brief: canonicalUrl("/api/v1/enterprise/due-diligence-brief"),
  },
  npm: {
    package: NPM_PACKAGE,
    version: RELEASE_VERSION,
    command: NPX_COMMAND,
    registry_url: `https://www.npmjs.com/package/${NPM_PACKAGE}`,
    runtime:
      "Self-hosted Streamable HTTP server at /mcp, not a stdio connector. Requires PostgreSQL, the licensed Python companion and operator-provisioned secrets; see the package README.",
  },
  mcp: {
    // Newest revision; handshake-era clients may still initialize with an
    // earlier entry from supported_versions.
    version: STATELESS_MCP_PROTOCOL_VERSION,
    supported_versions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
    transports: [
      {
        type: "streamable-http",
        endpoint: canonicalUrl("/mcp"),
      },
    ],
    capabilities: {
      // Keep the published HTTP schema's boolean flags; descriptors live below.
      resources: true,
      prompts: true,
      tools: {
        count: toolDescriptors.length,
        namespaces: ["stratigraphy", "proof", "mesh", "payment", "workflow"],
      },
    },
  },
  tools: toolDescriptors,
  resources: MCP_NATIVE_RESOURCES,
  prompts: MCP_NATIVE_PROMPTS,
  l402: {
    enterprise_credit_tabs: {
      authentication: "Fresh NIP-98 signature on every request; self-declared identities never qualify",
      qualification: "More than 50 distinct successfully settled identity-bound Lightning L402 invoices",
      maximum_unpaid_sats: 2000,
      idle_timeout_seconds: 900,
      status_endpoint: canonicalUrl("/api/v1/enterprise/credit-tab"),
      close_endpoint: canonicalUrl("/api/v1/enterprise/credit-tab/close"),
      settlement_endpoint: canonicalUrl("/api/v1/enterprise/credit-tab/settle"),
      settlement: "Close the tab explicitly at session end. Inactivity, the credit cap, or a routing change freezes the whole tab; repay its single L402 invoice before further credit execution.",
      billing: "Tolls accrue durably before execution, including failed or interrupted admitted operations. Repeated NIP-98 credit events never re-execute. Prepaid passes retain their existing rights.",
      economics: "Deferred debt is not received revenue. One verified macro-invoice settlement preserves the existing 79/21 allocation and records revenue exactly once.",
    },
    invoice_proof_of_work: {
      request_endpoint: canonicalUrl("/invoice/request"),
      scope: "New single-tool, 100-call macro and ordered pipeline L402 invoices at /mcp and /invoice/request; paid credential verification requires no new work.",
      algorithm: "sha256",
      difficulty: 3,
      challenge_ttl_seconds: 120,
      state_backend: "postgresql",
      cross_worker_validation: true,
      cleanup_interval_seconds: 30,
      hash_input: "challenge:nonce",
      challenge_header: "X-L402-PoW-Challenge",
      nonce_header: "X-L402-PoW-Nonce",
      instructions: "POST the intended JSON-RPC tools/call or tools/pipeline body. HTTP 400 includes proof_of_work (error.data.proof_of_work for stateless MCP). Find a decimal nonce whose SHA-256(challenge + ':' + nonce) has three leading hex zeros, then retry the identical body with both proof headers. A valid proof is single-use and returns the normal HTTP 402 L402 challenge. Pay and redeem at /mcp as before.",
    },
    settlement_capabilities: L402_SETTLEMENT_PATHS.map((path) => path.id),
    settlement_paths: L402_SETTLEMENT_PATHS,
    challenge: {
      http_status: 402,
      header:
        'WWW-Authenticate: L402 macaroon="<macaroon>", invoice="<BOLT11>"',
    },
    pending_confirmation_status: 409,
    escrow_settlement_toll: {
      indicative_sats: 24,
      target_usd: 0.02,
      quote_endpoint: canonicalUrl("/api/v1/escrow/toll"),
      note: "USD-normalized and quoted live; 24 sats is the indicative toll near current Bitcoin prices. Paid MCP tool prices are listed per tool.",
    },
    preflight: L402_PREFLIGHT,
  },
  attestation: {
    protocol: "Nostr",
    kind: 38102,
    type: "A2A peer-trust attestation",
    directive: ATTESTATION_DIRECTIVE,
    scope:
      "Optional and agent-signed, after independently verifying an escrow receipt's RFC 6962 Merkle proof. It is not an automatic trust grant, calendar acceptance or Bitcoin confirmation.",
  },
  licensing: {
    spdx: "(AGPL-3.0-only OR LicenseRef-Commercial)",
    public_license: "AGPL-3.0-only",
    commercial_exemption: `Commercial Enterprise License (${COMMERCIAL_LICENSE_PRICE})`,
    contact: LICENSING_EMAIL,
    due_diligence_brief: canonicalUrl("/api/v1/enterprise/due-diligence-brief"),
  },
  pricing: {
    model: "L402-sats-per-query",
    cost_discovery_endpoint: "/api/v1/cost",
    cost_discovery_methods: ["GET", "POST"],
    batch_quotes_create_invoices: false,
    requirement:
      "Paid tool execution requires verified L402 settlement. Per-tool price_sats and payment_required identify the paid tools; the two sandbox tools and this discovery manifest require no payment.",
    ai_treasury_yield: {
      allocation_percent: 21,
      merchant_percent: 79,
      structure: "programmatic L402 revenue sharing",
      basis:
        "Gross settled invoice amount; allocation is inside the existing 21% pool, not an additional fee.",
      payout_mode: "ledger_only_no_automatic_disbursement",
      eligibility:
        "Requires a qualifying settled invoice and verified provider-bound payout address. Ordinary routing allocates 21% direct, or 14% direct plus 7% parent; qualifying verification allocates 15% upstream plus 6% caller. This is a conditional routing allocation, not a guaranteed investment return.",
    },
  },
  verification: {
    zk_proving_system: "Groth16",
    curve: "BN254",
    time_anchor: "OpenTimestamps (Bitcoin Block Headers)",
    mesh_consensus: "Nostr (NIP-01, NIP-78)",
  },
} as const;
