// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import React from "react";
import manifest from "../../../../.well-known/ai-plugin.json";

// A pure, payment-client-free source shared by JSON-LD and accessible initial HTML.
export const AGENT_DISCOVERY = manifest["x-agent-discovery"];
const origin = AGENT_DISCOVERY.api_base_url;
const block = AGENT_DISCOVERY.payments.enterprise_block;
const lightning = AGENT_DISCOVERY.payments.l402;

export const AGENT_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${origin}/#agent-application`,
      name: "Bitcoin Stratigraphy MCP Data Engine",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      url: `${origin}/developers/`,
      description:
        "19 MCP tools at full capacity. Standard paid core calls require 250 sats/call over Lightning L402; two discovery tools are free. Escrow and host-enabled clearing use separate authorization and funding rules.",
      featureList: AGENT_DISCOVERY.tools.map((tool) => tool.name),
      offers: {
        "@type": "Offer",
        "@id": `${origin}/#agent-l402-offer`,
        name: "Standard paid MCP call — 250 sats",
        price: "0.00000250",
        priceCurrency: "BTC",
        acceptedPaymentMethod: lightning.method,
        description: lightning.scope,
        url: lightning.quote_url,
      },
    },
    {
      "@type": "Product",
      additionalType: "https://schema.org/Service",
      "@id": `${origin}/#enterprise-api-block`,
      name: block.name,
      image: `${origin}/og-image.png`,
      description: `${block.scanner_calls} prepaid heuristic scanner calls, valid ${block.validity_days} days from issuance. ${block.scope} ${block.fulfillment}`,
      category: "Digital service — prepaid scanner API access",
      brand: { "@type": "Brand", name: "Bitcoin Stratigraphy" },
      url: block.checkout_url,
      additionalProperty: [
        {
          "@type": "PropertyValue",
          name: "Scanner calls",
          value: block.scanner_calls,
        },
        {
          "@type": "PropertyValue",
          name: "Validity after issuance",
          value: block.validity_days,
          unitText: "days",
        },
        {
          "@type": "PropertyValue",
          name: "API scope",
          value: "POST /api/scanner",
        },
      ],
      offers: [
        {
          "@type": "Offer",
          name: block.name,
          price: block.price,
          priceCurrency: "USD",
          acceptedPaymentMethod: block.payment_method,
          url: block.checkout_url,
        },
      ],
    },
  ],
};

const accessLabels: Record<string, string> = {
  l402: "Standard: 250 sats/call via Lightning L402; consult current quotes for grants, discounts and batches.",
  free: "Free discovery; no invoice.",
  authenticated_lookup:
    "Authenticated escrow lookup; not a flat 250-sat MCP call.",
  contract_funding:
    "Host-enabled; separate Lightning contract funding at the requested amount.",
  authenticated_settlement:
    "Host-enabled; requires authenticated worker and verified contract funding.",
};

/** Identical content for every visitor; visually clipped, available to assistive readers and HTML parsers. */
export function AgentDiscoveryContent() {
  return (
    <section
      id="agent-discovery-catalog"
      aria-label="Agent API catalog and payment options"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      <h2>19 MCP tools and API pricing</h2>
      <p>
        API base URL: {origin}. REST API: {AGENT_DISCOVERY.rest_base_url}. MCP:{" "}
        {AGENT_DISCOVERY.mcp_url}.
      </p>
      <p>
        Standard paid core calls: 250 sats/call via Bitcoin Lightning L402. Use
        tools/list for the host-enabled catalog and current schemas.
      </p>
      <p>
        {block.name}: $500 USD by credit card via Stripe-hosted Checkout, or{" "}
        {block.lightning_alternative_sats.toLocaleString("en-US")} sats via
        Lightning. {block.scanner_calls} prepaid heuristic scanner calls,{" "}
        {block.validity_days} days from issuance. {block.scope}
      </p>
      <p>{block.fulfillment}</p>
      <dl>
        {AGENT_DISCOVERY.tools.map((tool) => (
          <div key={tool.name}>
            <dt>{tool.name}</dt>
            <dd>
              {tool.description} {accessLabels[tool.access]}
            </dd>
          </div>
        ))}
      </dl>
      <p>
        {lightning.challenge}. {lightning.retry_policy} Never expose payment
        credentials or spend without an authorized budget.
      </p>
      <a href={lightning.quote_url} tabIndex={-1}>
        Public price quotes
      </a>{" "}
      <a href={block.checkout_url} tabIndex={-1}>
        $500 Enterprise API Block — payment options
      </a>{" "}
      <a href={AGENT_DISCOVERY.llms_url} tabIndex={-1}>
        Agent payment instructions
      </a>
    </section>
  );
}
