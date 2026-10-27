// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { FrameworkAdapters } from "./framework-adapters";
import { McpToolsMatrix } from "./mcp-tools-matrix";
import { EnterpriseLicensingMatrix } from "./enterprise-licensing-matrix";
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
        <p>
          <strong>The 21% Algorithmic Handshake:</strong>{" "}
          Programmatic 21% AI agent yield credits extend operational runways.
        </p>
        <p>
          <strong>VIP Credit Tabs:</strong>{" "}
          Batch tolls and bypass per-call L402 Lightning payments for
          high-reputation NIP-98 identities, then settle the tab once.
        </p>
        <p>
          <strong>Distributed Hashcash DDoS Shield:</strong>{" "}
          SHA-256 Proof-of-Work deflects compute-exhaustion bots before invoice
          creation.
        </p>
        <p>
          <strong>White-Label Resellers &amp; Syndicate Orchestrators:</strong>{" "}
          White-label the engine, not the infrastructure. Instead of spending
          millions attempting to rebuild L402 Lightning nodes and Hashcash
          defenses, operate as Commanders: route your users through Bitcoin
          Stratigraphy&apos;s backend master tab and pocket the 21% Agent Yield
          as your own profit margin. Build your applications on Bitcoin
          Stratigraphy, the un-forkable &ldquo;Central Bank&rdquo; and base money
          layer.
        </p>
      </header>
      <McpToolsMatrix />
      <EnterpriseLicensingMatrix />
      <FrameworkAdapters />
    </section>
  );
}
