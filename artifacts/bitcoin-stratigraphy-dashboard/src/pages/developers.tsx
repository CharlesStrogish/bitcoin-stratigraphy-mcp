import React, { type ReactNode } from "react";

const REPO_URL = "https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp";
const MCP_ENDPOINT = "https://bitcoinstratigraphy.com/mcp";

function join(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const LANGCHAIN = `from bitcoin_stratigraphy_mcp_client import L402Nip98Transport
from langchain.agents import create_agent

async with L402Nip98Transport(private_key=key, wallet_handler=wallet) as tools:
    agent = create_agent(model, tools=tools)
    # Execute inside the context block to keep the MCP session alive`;

const CREWAI = `from crewai import Agent
from bitcoin_stratigraphy_mcp_client.crewai import CrewAISwarmTools

with CrewAISwarmTools(private_key=key, wallet_handler=wallet) as tools:
    agent = Agent(role="Treasury auditor", tools=tools)`;

const NAMESPACES = [
  ["stratigraphy", 5],
  ["proof", 7],
  ["mesh", 2],
  ["payment", 2],
  ["workflow", 1],
  ["clearing", 2],
] as const;

function Code({ label, children, id }: { label: string; children: string; id: string }) {
  return (
    <figure className="fn-code" data-testid={`code-${id}`}>
      <figcaption>{label}</figcaption>
      <pre><code>{children}</code></pre>
    </figure>
  );
}

/** `prepaidAccess` is a client-only slot: the SEO prerender omits it so static HTML stays payment-client-free. */
export default function DevelopersPage({ base = import.meta.env.BASE_URL, prepaidAccess }: { base?: string; prepaidAccess?: ReactNode }) {
  return (
    <div className="fn-page">
      <div className="fn-shell">
        <header className="fn-hero fn-rise">
          <p className="fn-kicker">For agent developers / Model Context Protocol</p>
          <h1 className="fn-title">
            Connect your agent to <span>19 MCP tools</span> in four lines.
          </h1>
          <p className="fn-lede">
            Bitcoin Stratigraphy exposes an MCP server over streamable HTTP. The Python client
            handles NIP-98 Schnorr authentication and L402 Lightning macaroons, so your agent calls
            tools and the transport settles access.
          </p>
          <div className="fn-cta-row">
            <a className="fn-btn fn-btn-primary" href={REPO_URL} rel="noopener" data-testid="link-repo">
              View repository
            </a>
            <a className="fn-btn" href={join(base, "llms.txt")} data-testid="link-llms">
              Read llms.txt
            </a>
            <a className="fn-btn fn-btn-quiet" href={join(base, "docs")} data-testid="link-docs">
              Developer docs
            </a>
          </div>
        </header>

        <section className="fn-grid fn-rise" aria-labelledby="dev-connect">
          <div>
            <p className="fn-step">01</p>
            <h2 id="dev-connect" className="fn-h2">Endpoint and source</h2>
            <dl className="fn-facts">
              <div>
                <dt>MCP endpoint</dt>
                <dd><code data-testid="text-mcp-endpoint">{MCP_ENDPOINT}</code></dd>
              </div>
              <div>
                <dt>Repository</dt>
                <dd><a href={REPO_URL} rel="noopener"><code>{REPO_URL.replace("https://", "")}</code></a></dd>
              </div>
              <div>
                <dt>Machine-readable spec</dt>
                <dd><a href={join(base, "llms.txt")}><code>/llms.txt</code></a></dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>AGPLv3 core. Commercial exemption available for proprietary deployments.</dd>
              </div>
            </dl>
          </div>
          <div>
            <p className="fn-step">02</p>
            <h2 className="fn-h2">Install</h2>
            <Code label="shell" id="install">pip install bitcoin-stratigraphy-mcp-client</Code>
            <h3 className="fn-h3">Self-host the MCP server</h3>
            <Code label="shell" id="server-install">{`npm install @bitcoin-stratigraphy/mcp-server@2.1.3
npx bitcoin-stratigraphy-mcp-server --help`}</Code>
            <p className="fn-note">
              Self-hosting requires Node.js 22+, PostgreSQL and Python enterprise
              dependencies. Configure the wallet and runtime as described in the{" "}
              <a href={`${REPO_URL}/blob/main/npm/mcp-server/README.md`} rel="noopener noreferrer">server deployment guide</a>.
              Installation alone does not start or fund a server.
            </p>
            <p className="fn-note">
              Discover the enabled catalog at runtime with <code>tools/list</code>. Clearing is a
              host-enabled extension and may not be present on every deployment.
            </p>
          </div>
        </section>

        <section className="fn-rise" aria-labelledby="dev-frameworks">
          <p className="fn-step">03</p>
          <h2 id="dev-frameworks" className="fn-h2">Framework integration</h2>
          <div className="fn-grid">
            <Code label="LangChain" id="langchain">{LANGCHAIN}</Code>
            <Code label="CrewAI" id="crewai">{CREWAI}</Code>
          </div>
        </section>

        <section className="fn-rise" aria-labelledby="dev-tools">
          <p className="fn-step">04</p>
          <h2 id="dev-tools" className="fn-h2">Tool namespaces</h2>
          <ul className="fn-ns">
            {NAMESPACES.map(([name, count]) => (
              <li key={name} data-testid={`ns-${name}`}>
                <code>{name}.*</code>
                <span>{count}</span>
                <i style={{ transform: `scaleX(${count / 7})` }} aria-hidden="true" />
              </li>
            ))}
          </ul>
          <p className="fn-note">
            <code>clearing.settle_contract</code> verifies Groth16 preimage receipts. It is preimage
            evidence, not proof of arbitrary task execution. Automated payouts and refunds are disabled.
          </p>
        </section>

        <section className="fn-rise fn-prepaid-section" aria-labelledby="dev-prepaid" data-testid="section-prepaid">
          <p className="fn-step">05</p>
          <h2 id="dev-prepaid" className="fn-h2">Prepaid API Access (B2B)</h2>
          <dl className="fn-facts fn-prepaid-scope" data-testid="text-prepaid-scope">
            <div><dt>Grants</dt><dd>100 calls to <code>POST /api/scanner</code></dd></div>
            <div><dt>Validity</dt><dd>Credits expire 30 days after issuance.</dd></div>
            <div><dt>Not included</dt><dd>Does not fund unrelated MCP tools; those settle per call over L402.</dd></div>
          </dl>
          {prepaidAccess ?? (
            <div className="fn-prepaid" data-testid="panel-prepaid-static">
              <div className="fn-prepaid-mint">
                <button type="button" className="fn-btn fn-btn-primary fn-btn-lg" disabled data-testid="button-mint-credits-static">
                  Mint 100 API Credits (100,000 sats)
                </button>
                <p className="fn-hint">The Lightning checkout loads in your browser.</p>
              </div>
            </div>
          )}
        </section>

        <aside className="fn-switch fn-rise">
          <span>Evaluating for an organization instead?</span>
          <a href={join(base, "audit")} data-testid="link-to-audit">Go to Enterprise Audit</a>
        </aside>
      </div>
    </div>
  );
}
