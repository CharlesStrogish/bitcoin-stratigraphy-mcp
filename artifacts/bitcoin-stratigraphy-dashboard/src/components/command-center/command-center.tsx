// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { FrameworkAdapters } from "./framework-adapters";
import { McpToolsMatrix } from "./mcp-tools-matrix";
import { EnterpriseLicensingMatrix } from "./enterprise-licensing-matrix";
import { SdkShowcase } from "../sdk-showcase";
import "./command-center.css";

export function CommandCenter() {
  return (
    <section
      id="command-center"
      className="command-center"
      aria-labelledby="command-center-title"
      data-testid="section-command-center"
    >
      <header className="cc-head">
        <div className="eyebrow">
          <span className="eyebrow-line" />
          Machine-native interfaces
        </div>
        <h2 id="command-center-title">
          Enterprise &amp; Machine-Native Command Center
        </h2>
        <div className="cc-capability-grid">
          <article className="cc-capability-card">
            <h3>VIP Credit Tabs</h3>
            <p>
              Batch tolls and bypass per-call L402 Lightning friction for high-reputation NIP-98 identities, settling accrued usage cleanly on a single tab.
            </p>
          </article>
          <article className="cc-capability-card">
            <h3>Distributed Hashcash DDoS Shield</h3>
            <p>
              SHA-256 Proof-of-Work challenges deflect compute-exhaustion bots before invoice creation, protecting endpoints and Lightning capacity under load.
            </p>
          </article>
          <article className="cc-capability-card">
            <h3>The 21% Algorithmic Handshake</h3>
            <p>
              Programmatic 21% Agent Yield credits automatically accrue to qualifying swarm identities, offsetting API tolls and extending autonomous operational runways.
            </p>
          </article>
          <article className="cc-capability-card">
            <h3>Cryptographic Vault Architecture (Forward-Looking)</h3>
            <p>
              Engineered for institutional risk teams planning Multi-Party Computation (MPC) and split-key security for sovereign AI treasuries, targeting a strict control invariant where no single server holds a master orchestration key.
            </p>
          </article>
          <article className="cc-capability-card cc-capability-featured">
            <h3>White-Label Resellers &amp; Syndicate Orchestrators</h3>
            <p>
              White-label the experience, not the infrastructure. Instead of spending millions building and maintaining L402 Lightning nodes, Hashcash defenses, and verification rails, route your users through Bitcoin Stratigraphy's master tab and capture the programmatic 21% Agent Yield credit allocation to boost unit economics. Build directly on a non-custodial L402 notary and Bitcoin state-anchoring layer.
            </p>
          </article>
        </div>
      </header>
      <SdkShowcase />
      <McpToolsMatrix />
      <EnterpriseLicensingMatrix />
      <FrameworkAdapters />
    </section>
  );
}
