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
              Article 12 of the EU AI Act addresses automatic event recording for high-risk AI systems. Ordinary logs can be edited, overwritten, or deleted unless appropriate controls are applied. Cryptographic commitments can help detect changes to retained logs, but Article 12 does not universally mandate Bitcoin anchoring or make ordinary IT logs legally insufficient. Organizations remain responsible for logging scope, retention, access controls, and applicable legal requirements.
            </p>
          </section>

          <section id="solution" className="panel cmp-sec">
            <h2>2. The L402 + RFC 6962 Solution</h2>
            <p>
              The Bitcoin Stratigraphy Data Engine provides cryptographic evidence that can support Article 12 record-keeping. Applications integrate event capture and retain original logs alongside commitments; the following controls do not independently establish regulatory compliance:
            </p>
            <ul>
              <li>
                <strong>L402 Micro-Settlements:</strong> Autonomous agents do not wait for human procurement. They programmatically fund their own execution traces using Lightning Network micro-settlements with a current 24-sat (~$0.02) toll preview and dynamic server pricing, bypassing API key bottlenecks and credit card walls.
              </li>
              <li>
                <strong>RFC 6962 Merkle Evidence:</strong> Captured events can be committed to an ordered Merkle tree. Verification detects changes to committed bytes against a trusted retained root. Integrators must capture the required events and retain checkpoints; hashing alone does not prove completeness or automatically alert auditors.
              </li>
              <li>
                <strong>NIP-98 Agent Identity Binding:</strong> Schnorr signatures authenticate the key signing an identity-bound HTTP request. Binding that identity into a Merkle receipt supports provenance review; it does not independently prove which software process executed a decision or satisfy every Article 12 requirement.
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
              Bitcoin Stratigraphy is available under AGPLv3. Merely calling a public API does not by itself require publication of an unrelated proprietary codebase or model weights. Obligations depend on how the covered software is modified, combined, conveyed, or offered over a network; review the license for your deployment. We provide separate self-serve <strong>AGPLv3 Commercial Copyright Waivers</strong>: $2,500/30 days or $25,000/365 days per swarm, and $25,000/30 days or $250,000/365 days for a global organization, quoted in BTC at spot.
            </p>
            <p>A confirmed waiver supports:</p>
            <ul>
              <li>Complete IP Protection: A time-locked waiver from AGPLv3 Section 13 network source-disclosure requirements for the purchased term.</li>
              <li>Air-Gapped Deployment: The legal right to deploy the Notary Hub and Escrow Oracle entirely on-premises or within isolated internal networks.</li>
              <li>Local Deployment Controls: Configure local telemetry and review service dependencies for isolated deployments. Lightning settlement, public Bitcoin data, and public timestamp calendars require network access unless replaced with suitable local infrastructure; a waiver does not itself make the system air-gapped.</li>
              <li><strong>Cryptographic Tool Integrity:</strong> Clients can pin and verify the Ed25519-signed tool manifest to detect changed metadata. A valid signature is not a guarantee against every tool-poisoning or prompt-injection attack.</li>
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
