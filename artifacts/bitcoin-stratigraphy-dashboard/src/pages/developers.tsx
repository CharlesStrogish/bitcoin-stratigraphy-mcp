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
            <a className="fn-btn fn-btn-quiet" href={join(base, "blog/enterprise-troubleshooting/")} data-testid="link-enterprise-troubleshooting">
              Enterprise troubleshooting
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
            <div><dt>Grants</dt><dd>100 calls to <code>POST /api/scanner</code> ($500 card or $450 BTC spot quote), or 1,000 calls in the Bitcoin-only Heavy Swarm Pack ($4,000 BTC spot quote)</dd></div>
            <div><dt>Validity</dt><dd>100-call credits expire 30 days after issuance; Heavy Swarm Pack credits expire after 90 days.</dd></div>
            <div><dt>Not included</dt><dd>Does not fund unrelated MCP tools; those settle per call over L402.</dd></div>
          </dl>
          {prepaidAccess ?? (
            <div className="fn-prepaid" data-testid="panel-prepaid-static">
              <div className="fn-prepaid-mint">
                <button type="button" className="fn-btn fn-btn-primary fn-btn-lg" disabled data-testid="button-mint-credits-static">
                  Mint 100 API Credits ($450 in BTC)
                </button>
                <p className="fn-hint">The Lightning checkout loads in your browser.</p>
              </div>
            </div>
          )}
        </section>

        <section className="fn-rise" aria-labelledby="swarm-continuity" data-testid="section-swarm-continuity">
          <p className="fn-step">06</p>
          <h2 id="swarm-continuity" className="fn-h2">Swarm Continuity &amp; Disaster Recovery</h2>
          <p className="fn-note">
            Troubleshooting a crashed swarm? Follow the{" "}
            <a href={join(base, "blog/enterprise-troubleshooting/")}>enterprise disaster-recovery guide</a>{" "}
            for LangChain and CrewAI hallucination errors, Stripe 5xx timeouts,
            and Article 12 audit evidence blockers.
          </p>
          <p className="fn-lede">
            A Global Disaster Recovery Hub for enterprise AI swarms: native Lightning
            keeps a payment path available when legacy fiat APIs fail. Enterprise
            architects evaluating AI failover protocols and LLM disaster recovery
            can integrate machine-readable L402 continuity without replacing the
            existing Stripe/Brevo fulfillment loop.
          </p>
          <p className="fn-note">
            The fiat-to-Lightning scanner gateway preserves successful Stripe checkout.
            A five-second deadline, upstream timeout or Stripe 5xx response activates a
            native Lightning invoice for 100 scanner calls, priced as a $450 BTC/USD spot quote locked for 15 minutes,, valid for 30 days after
            issuance. Existing payable or paid card sessions must be recovered first.
            No payment is sent automatically, and scanner credits do not authorize
            unrelated MCP tools.
          </p>
          <Code label="HTTP 402 · native Lightning continuity" id="continuity">{`WWW-Authenticate: L402 macaroon="<token>", invoice="<BOLT11>",
  error="fiat_gateway_offline", fallback="native_lightning_active"

POST /api/mint-macaroon
Authorization: L402 <token>:<payment-preimage>`}</Code>
          <p className="fn-note">
            For zero-friction swarm execution, preconfigure an authorized Lightning wallet
            and spending limits. Validate the quote, pay the invoice once, then redeem
            the same challenge at the returned payment endpoint. A 402 is not proof of
            payment. Signature checks, expiry, revocation, exact payment verification
            and shared credit limits remain enforced on both rails.
          </p>
          <p className="fn-note">
            The 19-tool platform already settles MCP access natively over L402; this
            wrapper protects the fiat scanner procurement path. Continuity during global
            fiat API outages still requires a working Lightning wallet, network and
            server. If Lightning is unavailable too, the gateway fails closed rather
            than granting unpaid access. An uncertain Stripe session stays recoverable
            through the original browser; never pay twice.
          </p>
        </section>

        <aside className="fn-switch fn-rise">
          <span>Evaluating for an organization instead?</span>
          <a href={join(base, "audit")} data-testid="link-to-audit">Go to Enterprise Audit</a>
        </aside>
      </div>
    </div>
  );
}
