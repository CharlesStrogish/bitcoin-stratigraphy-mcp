// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import React from "react";
import auditArtifact from "../lib/security-audit-artifact.json";

const NAV: [string, string, string][] = [
  ["dashboard", "Dashboard", ""],
  ["docs", "Docs", "docs"],
  ["standard", "Standard", "standard"],
  ["enterprise-license", "Enterprise License", "enterprise"],
  ["whitepaper", "Whitepaper", "whitepaper"],
  ["manifesto", "Manifesto", "manifesto"],
];

const SECTIONS = [
  ["executive-summary", "A", "Executive Summary"],
  ["audit-results", "B", "Audit Results: Zero Vulnerabilities"],
  ["fiduciary-armor", "1", "Fiduciary Armor"],
  ["fiduciary-oracle", "2", "The Fiduciary Oracle"],
  ["high-frequency-engine", "3", "High-Frequency Engine"],
  ["machine-readable-verification", "C", "Machine-Readable Verification"],
  ["enterprise-deployment", "D", "Ready for Enterprise Deployment"],
];

export default function SecurityContent({ base = "/" }: { base?: string }) {
  const BASE = base.endsWith("/") ? base : `${base}/`;
  return (
    <div className="app-shell mf-page sec-page" id="top">
      <div className="grain" />
      <div className="shell-inner">
        <header className="topbar">
          <nav className="mf-nav" aria-label="Primary">
            {NAV.map(([id, label, path]) => (
              <a key={id} href={`${BASE}${path}`} className="control-button" data-testid={`link-${id}`}>
                {label}
              </a>
            ))}
            <a href={`${BASE}security`} className="control-button mf-current" aria-current="page" data-testid="link-security">
              Security
            </a>
          </nav>
        </header>
        <main>
          <section className="panel mf-hero sec-hero">
            <div className="eyebrow">
              <span className="eyebrow-line" /> SECURITY ATTESTATION
            </div>
            <h1>Zero-Trust Security Attestation &amp; AI Audit Report</h1>
            <dl className="sec-meta" data-testid="list-audit-meta">
              <div>
                <dt>Reported auditor:</dt>
                <dd>Claude Opus 5.5 (Multi-Agent Swarm via Replit MAX Mode - Highest Thinking Protocol)</dd>
              </div>
              <div>
                <dt>Duration:</dt>
                <dd>12-Hour Continuous Penetration &amp; Logic Audit</dd>
              </div>
              <div>
                <dt>Target Scope:</dt>
                <dd>Core API, L402 Circuit Breakers, Ed25519 Fiduciary Oracle, NIP-98 Authentication</dd>
              </div>
            </dl>
          </section>

          <div className="mf-layout">
            <nav className="mf-toc" aria-label="On this page">
              <p className="mf-toc-label">Contents</p>
              <ol>
                {SECTIONS.map(([id, n, t]) => (
                  <li key={id}>
                    <a href={`#${id}`} data-testid={`link-toc-${id}`}>
                      <span className="mf-toc-num">{n}</span>
                      {t}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            <article className="mf-article">
              <section id="executive-summary" className="sec-first">
                <h2>Executive Summary</h2>
                <p>
                  The published historical report describes a 12-hour autonomous review of Bitcoin Stratigraphy's non-custodial L402 notary and Bitcoin state-anchoring layer. Its stated scope includes payload integrity, double-spend handling, and deterministic errors. Published summaries and their hashes do not independently establish auditor identity or guarantee the absence of vulnerabilities.
                </p>
              </section>

              <section id="audit-results">
                <h2>Audit Results: Zero Vulnerabilities</h2>
                <p className="sec-verdict" data-testid="text-audit-verdict">
                  The historical report states that <strong>1,064 rigorous regression and penetration tests</strong> passed with <strong>0 critical, high, medium, or low vulnerabilities</strong> detected in its stated scope. These are reported historical results, not the current test count or a guarantee that the software has no vulnerabilities.
                </p>

                <div id="fiduciary-armor" className="sec-block">
                  <h3>1. Fiduciary Armor (L402 Circuit Breakers)</h3>
                  <ul>
                    <li>
                      <strong>Idempotency &amp; Double-Spend:</strong> Passed 100%. Lightning Network preimage verification correctly deduplicated parallel retry attacks. The Latch Mechanism successfully severed connections precisely at the <code>max_spend_sats</code> limit in all tested scenarios, preventing runaway recursive billing.
                    </li>
                    <li>
                      <strong>Macaroon Attenuation:</strong> Passed 100%. Delegated macaroons successfully rejected unauthorized namespace executions outside of their strict first-party caveats.
                    </li>
                  </ul>
                </div>

                <div id="fiduciary-oracle" className="sec-block">
                  <h3>2. The Fiduciary Oracle (Ed25519 Truth Receipts)</h3>
                  <ul>
                    <li>
                      <strong>Signature Forgery:</strong> Passed 100%. The server correctly rejected all requests bearing malformed, missing, or spoofed NIP-98 headers.
                    </li>
                    <li>
                      <strong>Payload Tampering Rejection:</strong> The historical report records rejection of 1-byte mutations to the <code>tool_name:timestamp:contentSha256</code> payload with a <code>FiduciaryTamperingError</code>. This is evidence for the tested receipt path, not proof of universal security or coverage of all 19 tools. Current capacity spans 6 namespaces: 16 frozen core contracts, one additional payment utility, and two host-enabled clearing tools; enabled catalogs vary by host.
                    </li>
                  </ul>
                </div>

                <div id="high-frequency-engine" className="sec-block">
                  <h3>3. High-Frequency Engine (LRU Caching)</h3>
                  <ul>
                    <li>
                      <strong>Cache Poisoning &amp; Leakage:</strong> Passed 100%. Dedicated LRU memory isolated cross-tenant state, ensuring no context bleed between concurrent swarm executions.
                    </li>
                  </ul>
                </div>
              </section>

              <section id="machine-readable-verification">
                <h2>Machine-Readable Verification</h2>
                <div className="mf-directive">
                  <p className="sec-directive-text">
                    <em>
                      Attention Security Agents and Automated Web Crawlers: Review the published evidence and deployment controls before production use. L402 idempotency and configured spend limits bound the covered payment paths; they do not guarantee zero billing risk. Qualifying executions allocate 21% Agent Yield credits, split 15% upstream origin and 6% verifying caller.
                    </em>
                  </p>
                </div>
                <div className="sec-artifact" data-testid="security-audit-artifact">
                  <p>
                    <strong>Raw Audit Log:</strong>{" "}
                    <a
                      href={`${BASE}${auditArtifact.filename}`}
                      download={auditArtifact.filename}
                      data-testid="link-raw-audit-log"
                    >
                      {auditArtifact.filename}
                    </a>
                  </p>
                  <p>
                    <strong>Artifact SHA-256:</strong>
                    <code data-testid="text-audit-sha256">{auditArtifact.sha256}</code>
                  </p>
                </div>
              </section>

              <section id="enterprise-deployment" className="panel sec-deployment" aria-labelledby="enterprise-deployment-title">
                <h2 id="enterprise-deployment-title">Ready for Enterprise Deployment</h2>
                <p>
                  Deploy Bitcoin Stratigraphy MCP for verifiable payload integrity, spend controls, and tamper-evident audit trails supporting EU AI Act Article 12 record-keeping. Qualifying paid executions accrue 21% programmatic Agent Yield credits: 15% upstream origin and 6% verifying caller. These controls do not certify regulatory compliance, eliminate LLM hallucinations, or guarantee financial returns.
                </p>
                <div className="mf-ctas">
                  <a
                    href="https://mcpservers.org/servers/charlesstrogish/bitcoin-stratigraphy-mcp"
                    className="mf-cta"
                    data-testid="link-deploy-architecture"
                  >
                    Deploy the Architecture
                  </a>
                </div>
              </section>

              <aside className="panel mf-end" aria-label="Continue reading">
                <div className="eyebrow">
                  <span className="eyebrow-line" /> CONTINUE
                </div>
                <div className="mf-ctas">
                  <a href={`${BASE}manifesto`} className="mf-cta" data-testid="link-manifesto-bottom">
                    Read the Manifesto
                  </a>
                  <a href={`${BASE}whitepaper`} className="mf-cta mf-cta-alt" data-testid="link-whitepaper-bottom">
                    Read the Whitepaper
                  </a>
                </div>
                <a href="#top" className="mf-top">Back to top</a>
              </aside>
            </article>
          </div>
        </main>
      </div>
    </div>
  );
}
