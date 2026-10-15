// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import type { UseQueryResult } from "@tanstack/react-query";
import { ExternalLink, Package, RefreshCw } from "lucide-react";
import {
  CANONICAL_MCP_TOOLS,
  CANONICAL_MCP_TOOL_NAMES,
  MCP_ENDPOINT,
  MCP_NAMESPACE_COLUMNS,
  MCP_NAMESPACE_SUMMARIES,
  NPM_PACKAGE_URL,
  NPX_INSTALL_COMMAND,
  type McpNamespace,
} from "./catalog";
import { CopyTextButton } from "./copy-text-button";
import { formatSats } from "./format";
import { useMcpToolQuote, type McpToolQuote } from "./live-data";

type QuoteState = "pending" | "error" | "ready";

function PriceTag({
  price,
  state,
}: {
  price: number | undefined;
  state: QuoteState;
}) {
  if (state === "pending") {
    return (
      <span className="cc-price cc-price-muted">
        <span aria-hidden="true">···</span>
        <span className="sr-only">Quoting price</span>
      </span>
    );
  }
  if (state === "error" || price === undefined) {
    return (
      <span className="cc-price cc-price-muted" title="Live quote unavailable">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Price unavailable</span>
      </span>
    );
  }
  if (price === 0) return <span className="cc-price cc-price-free">Free</span>;
  return <span className="cc-price">{formatSats(price)}</span>;
}

function paidPriceRange(quote: McpToolQuote) {
  const paid = [...quote.prices.values()].filter((price) => price > 0);
  if (!paid.length) return null;
  return { count: paid.length, min: Math.min(...paid), max: Math.max(...paid) };
}

function QuoteSummary({
  query,
}: {
  query: UseQueryResult<McpToolQuote, Error>;
}) {
  if (query.isPending) {
    return (
      <p className="cc-quote-status" role="status">
        Quoting live prices…
      </p>
    );
  }
  if (query.isError) {
    return (
      <div className="cc-quote-status cc-quote-error" role="alert">
        Live price quote unavailable.
        <button
          type="button"
          className="cc-retry"
          onClick={() => void query.refetch()}
          data-testid="button-retry-mcp-quote"
        >
          <RefreshCw size={12} aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }
  const free = CANONICAL_MCP_TOOL_NAMES.filter(
    (name) => query.data.prices.get(name) === 0,
  ).length;
  const paid = paidPriceRange(query.data);
  return (
    <dl className="cc-quote-chips" data-testid="text-mcp-quote-summary">
      <div>
        <dt>Tools</dt>
        <dd>{CANONICAL_MCP_TOOL_NAMES.length}</dd>
      </div>
      <div>
        <dt>Namespaces</dt>
        <dd>{Object.keys(CANONICAL_MCP_TOOLS).length}</dd>
      </div>
      <div>
        <dt>Free sandbox</dt>
        <dd>{free}</dd>
      </div>
      <div>
        <dt>Paid per call</dt>
        <dd>
          {paid === null
            ? "None"
            : paid.min === paid.max
              ? formatSats(paid.min)
              : `${paid.min.toLocaleString("en-US")}–${formatSats(paid.max)}`}
        </dd>
      </div>
    </dl>
  );
}

function BatchTerms({ quote }: { quote: McpToolQuote }) {
  const { batch } = quote;
  if (!batch) {
    return (
      <p className="cc-batch cc-batch-missing">
        This deployment does not advertise Macro-Macaroon batch terms.
      </p>
    );
  }
  const paid = paidPriceRange(quote);
  const example =
    paid && paid.min === paid.max
      ? ` (${formatSats(paid.min * batch.price_multiplier)} for a ${paid.min.toLocaleString("en-US")}-sat tool)`
      : "";
  return (
    <div className="cc-batch" data-testid="text-batch-terms">
      <div className="section-kicker">Macro-Macaroon batch</div>
      <code>
        {batch.request_header}: {batch.header_value}
      </code>
      <p>
        One credential scoped to the {batch.credential_scope}, valid for{" "}
        {batch.max_requests} calls at {batch.price_multiplier}× the per-call fee
        {example}. Present it as{" "}
        <code>Authorization: {quote.authorizationFormat}</code>.
      </p>
    </div>
  );
}

function NamespaceCard({
  namespace,
  quote,
  state,
}: {
  namespace: McpNamespace;
  quote: McpToolQuote | undefined;
  state: QuoteState;
}) {
  const tools = CANONICAL_MCP_TOOLS[namespace];
  return (
    <div
      className={`cc-ns cc-ns-${namespace}`}
      data-testid={`namespace-${namespace}`}
    >
      <div className="cc-ns-head">
        <h4>{namespace}</h4>
        <span>
          {tools.length} {tools.length === 1 ? "tool" : "tools"}
        </span>
      </div>
      <p className="cc-ns-summary">{MCP_NAMESPACE_SUMMARIES[namespace]}</p>
      <ul className="cc-tool-list">
        {tools.map((tool) => (
          <li
            className="cc-tool"
            key={tool.name}
            data-testid={`tool-${tool.name}`}
          >
            <div className="cc-tool-text">
              <code>{tool.name}</code>
              <span>{tool.title}</span>
            </div>
            <PriceTag price={quote?.prices.get(tool.name)} state={state} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function McpToolsMatrix() {
  const quote = useMcpToolQuote();
  const state: QuoteState = quote.isPending
    ? "pending"
    : quote.isError
      ? "error"
      : "ready";
  return (
    <section
      className="cc-module cc-tools"
      aria-labelledby="cc-tools-title"
      data-testid="module-mcp-tools"
    >
      <div className="cc-module-head">
        <div className="cc-module-intro">
          <div className="section-kicker">01 · MCP tools matrix</div>
          <h3 id="cc-tools-title">The 15 Canonical MCP Tools</h3>
          <p>
            Dot-notation tools in four namespaces over Streamable HTTP. Fees are
            quoted live by <code>POST /api/v1/cost</code>, which never creates
            an invoice.
          </p>
        </div>
        <QuoteSummary query={quote} />
      </div>

      <div className="cc-install">
        <div className="cc-install-command">
          <span className="cc-install-label">
            <Package size={13} aria-hidden="true" /> npm
          </span>
          <code data-testid="text-npx-command">
            <span className="cc-prompt" aria-hidden="true">
              ${" "}
            </span>
            {NPX_INSTALL_COMMAND}
          </code>
        </div>
        <CopyTextButton
          variant="primary"
          text={NPX_INSTALL_COMMAND}
          label="Copy npx install"
          copiedLabel="Copied npx command"
          description={`Copy “${NPX_INSTALL_COMMAND}” to the clipboard`}
          testId="button-copy-npx"
        />
      </div>
      <p className="cc-install-note">
        Launches the self-hosted Streamable HTTP server, not a stdio connector.
        It needs PostgreSQL, the licensed Python companion and
        operator-provisioned secrets; see the{" "}
        <a
          href={NPM_PACKAGE_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="link-npm-package"
        >
          package README on npm
          <ExternalLink size={11} aria-hidden="true" />
        </a>
        . Hosted endpoint: <code>{MCP_ENDPOINT}</code>{" "}
        <CopyTextButton
          variant="compact"
          text={MCP_ENDPOINT}
          label="Copy"
          context="hosted MCP endpoint URL"
          description="Copy the hosted MCP endpoint URL"
          testId="button-copy-mcp-endpoint"
        />
      </p>

      <div className="cc-ns-grid">
        {MCP_NAMESPACE_COLUMNS.map((column) => (
          <div className="cc-ns-column" key={column.join("-")}>
            {column.map((namespace) => (
              <NamespaceCard
                key={namespace}
                namespace={namespace}
                quote={quote.data}
                state={state}
              />
            ))}
          </div>
        ))}
      </div>

      {quote.data && <BatchTerms quote={quote.data} />}
    </section>
  );
}
