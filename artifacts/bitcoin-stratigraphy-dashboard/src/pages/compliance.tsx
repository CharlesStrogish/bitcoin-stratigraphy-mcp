// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect } from "react";
import Article12VerifierLink from "@/components/article12-verifier-link";
import {
  COMPLIANCE_TITLE,
  COMPLIANCE_DESCRIPTION,
  COMPLIANCE_URL,
  COMPLIANCE_ARTICLE,
} from "@/lib/compliance-seo";
import { CisoIntakeActions } from "@/components/ciso-intake-actions";
import "./compliance.css";

const BASE = import.meta.env.BASE_URL;
const MAIL = `${BASE}#enterprise-licensing`;

const NAV: [string, string, string][] = [
  ["dashboard", "Dashboard", ""],
  ["standard", "Standard", "standard"],
  ["simulator", "Enterprise Preview", "simulator"],
  ["whitepaper", "Whitepaper", "whitepaper"],
  ["enterprise", "Enterprise License", "enterprise"],
];

type Spec = { sel: string; create: () => Element; attr: string; value: string };

function useComplianceHead() {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = COMPLIANCE_TITLE;
    const meta = (k: string, n: string): Spec => ({
      sel: `meta[${k}="${n}"]`,
      create: () => {
        const m = document.createElement("meta");
        m.setAttribute(k, n);
        return m;
      },
      attr: "content",
      value: "",
    });
    const specs: Spec[] = [
      { ...meta("name", "description"), value: COMPLIANCE_DESCRIPTION },
      {
        sel: 'link[rel="canonical"]',
        create: () => {
          const l = document.createElement("link");
          l.setAttribute("rel", "canonical");
          return l;
        },
        attr: "href",
        value: COMPLIANCE_URL,
      },
      { ...meta("property", "og:title"), value: COMPLIANCE_TITLE },
      { ...meta("property", "og:description"), value: COMPLIANCE_DESCRIPTION },
      { ...meta("property", "og:url"), value: COMPLIANCE_URL },
      { ...meta("property", "og:type"), value: "article" },
      { ...meta("name", "twitter:title"), value: COMPLIANCE_TITLE },
      { ...meta("name", "twitter:description"), value: COMPLIANCE_DESCRIPTION },
      { ...meta("name", "twitter:url"), value: COMPLIANCE_URL },
    ];
    const restores = specs.map((s) => {
      let el = document.head.querySelector(s.sel);
      const created = !el;
      const old = el?.getAttribute(s.attr) ?? null;
      if (!el) {
        el = s.create();
        document.head.appendChild(el);
      }
      el.setAttribute(s.attr, s.value);
      const node = el;
      return () => {
        if (created) node.remove();
        else if (old !== null) node.setAttribute(s.attr, old);
        else node.removeAttribute(s.attr);
      };
    });
    document.getElementById("compliance-article-jsonld")?.remove();
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.id = "compliance-article-jsonld";
    script.textContent = JSON.stringify(COMPLIANCE_ARTICLE);
    document.head.appendChild(script);
    return () => {
      document.title = prevTitle;
      restores.forEach((r) => r());
      script.remove();
    };
  }, []);
}

export default function CompliancePage() {
  useComplianceHead();

  return (
    <div className="app-shell cmp-page">
      <div className="shell-inner">
        <header className="topbar">
          <nav className="cmp-nav" aria-label="Primary">
            <Article12VerifierLink />
            {NAV.map(([k, label, path]) => (
              <a key={k} href={`${BASE}${path}`} className="control-button" data-testid={`link-${k}`}>
                {label}
              </a>
            ))}
            <a
              href={`${BASE}compliance`}
              className="control-button cmp-current"
              aria-current="page"
              data-testid="link-compliance"
            >
              Enterprise Compliance
            </a>
          </nav>
          <h1 data-testid="text-compliance-title">
            EU AI Act Article 12 Compliance Sandbox: Autonomous Proof-of-Execution
          </h1>
        </header>

        <main className="cmp-main">
          <section id="problem" className="panel cmp-sec">
            <h2>1. The Enterprise Compliance Problem</h2>
            <p>
              Under Article 12 of the EU AI Act, organizations deploying high-risk autonomous AI systems must ensure the automatic, tamper-proof recording of events throughout the system's lifetime. When a regulatory auditor investigates an AI agent's decision six months after execution, standard IT logs are legally insufficient. A traditional log file can be quietly edited, overwritten, or deleted by a system administrator without leaving a trace, entirely breaking the chain of custody. If an enterprise cannot cryptographically prove that an agent's execution trace was complete, unaltered, and properly governed, they face severe regulatory penalties.
            </p>
          </section>

          <section id="solution" className="panel cmp-sec">
            <h2>2. The L402 + RFC 6962 Solution</h2>
            <p>
              The Bitcoin Stratigraphy Data Engine solves the Article 12 mandate natively by replacing mutable databases with mathematically non-repudiable state-anchoring. We combine two protocols to create an enterprise-grade "Flight Recorder" for multi-agent swarms:
            </p>
            <ul>
              <li>
                <strong>L402 Micro-Settlements:</strong> Autonomous agents do not wait for human procurement. They programmatically fund their own execution traces using Lightning Network micro-settlements with a current 24-sat (~$0.02) toll preview and dynamic server pricing, bypassing API key bottlenecks and credit card walls.
              </li>
              <li>
                <strong>RFC 6962 Merkle Evidence:</strong> Every agent thought, context window, and tool execution is hashed into an append-only Merkle tree. If a single comma in a historical agent log is altered, the cryptographic root hash fractures, immediately alerting auditors to tampering.
              </li>
              <li>
                <strong>NIP-98 Agent Identity Binding:</strong> Satisfies Article 12 chain-of-custody requirements by using Schnorr signatures to mathematically authenticate exactly which autonomous sub-agent executed a decision, anchoring their identity permanently into the Merkle receipt.
              </li>
            </ul>
          </section>

          <section id="walkthrough" className="panel cmp-sec">
            <h2>3. Enterprise Interactive Preview: Agent Settlement Walkthrough</h2>
            <p>
              To demonstrate this cryptographic custody chain without requiring an active Lightning Network wallet, use our Enterprise Interactive Preview. The separate Live REST Escrow terminal on the main dashboard executes real Lightning Network micropayments via L402 and Nostr Wallet Connect. Follow these exact steps to view the compliance evidence your engineering team will receive in production:
            </p>
            <ol>
              <li>
                <strong>Navigate to the Escrow Terminal:</strong> Return to the main dashboard.
              </li>
              <li>
                <strong>Run the Enterprise Interactive Preview:</strong> Click the yellow "Run Preview" button.
              </li>
              <li>
                <strong>Analyze the Flow:</strong> The UI visually guides you through the machine settlement: Agent A locks the bounty, Agent B submits the execution trace, and the Stratigraphy Hub validates the RFC 6962 Merkle leaf. The live terminal shows a current 24-sat (~$0.02) toll preview; settlement uses the contract's dynamic server price.
              </li>
              <li>
                <strong>Export the Evidence:</strong> Click the "Copy Escrow Proof (JSON)" button. This JSON-LD payload is the exact, audit-ready structured data your risk team will hand to EU regulators.
              </li>
            </ol>
          </section>

          <section id="licensing" className="panel cmp-sec">
            <h2>4. Enterprise Air-Gapped Licensing</h2>
            <p>
              The public Bitcoin Stratigraphy network operates under the AGPLv3 Open-Source License. If you connect your proprietary internal AI swarms to the public network, the AGPLv3 legally mandates that you open-source your entire proprietary AI codebase and model weights to the public. For massive technology corporations that cannot expose proprietary agent logic, we provide self-serve <strong>AGPLv3 Commercial Copyright Waivers</strong>: $2,500/30 days or $25,000/365 days per swarm, and $25,000/30 days or $250,000/365 days for a global organization, quoted in BTC at spot.
            </p>
            <p>A confirmed waiver supports:</p>
            <ul>
              <li>Complete IP Protection: A time-locked waiver from AGPLv3 Section 13 network source-disclosure requirements for the purchased term.</li>
              <li>Air-Gapped Deployment: The legal right to deploy the Notary Hub and Escrow Oracle entirely on-premises or within isolated internal networks.</li>
              <li>Zero-Telemetry Sovereign Guarantee: 100% offline, self-contained execution with zero vendor backdoors, network phone-home pings, or third-party dependencies.</li>
              <li><strong>Cryptographic Tool Integrity:</strong> Defeats LLM tool-poisoning attacks by hashing and signing all MCP tool descriptions via an immutable Ed25519 public manifest.</li>
              <li><strong>Stateless Horizontal Scaling:</strong> Upgraded to the stateless MCP 2026-07-28 transport, completely removing session bottlenecks for high-concurrency agent swarms.</li>
            </ul>
            <p>{"All prepaid MCP Macro-Macaroons, Scanner Packs, and AGPLv3 Commercial Copyright Waivers are 100% self-serve and provided STRICTLY AS-IS, WITH ALL FAULTS. Zero SLAs, zero uptime warranties, zero indemnity, zero custom MSAs, zero vendor questionnaires, and zero support obligations. Full source code is publicly inspectable under AGPLv3 for independent self-hosting. Payment for a Commercial Copyright Waiver strictly grants a time-locked, non-negotiable waiver from AGPLv3 Section 13 network source-disclosure requirements for the specified term, anchored cryptographically to your confirmed Bitcoin transaction."}</p>
            <p>
              <a href={MAIL} className="cmp-mail" data-testid="link-contact-licensing">
                Buy a waiver at /#enterprise-licensing
              </a>
            </p>
            <CisoIntakeActions testIdPrefix="compliance" />
            <div className="cmp-actions">
              <a href={`${BASE}#live-escrow-terminal`} className="cmp-cta" data-testid="link-access-simulator">
                Access Live REST Escrow
              </a>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
