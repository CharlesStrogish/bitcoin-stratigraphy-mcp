import { useEffect } from "react";
import Article12VerifierLink from "@/components/article12-verifier-link";
import {
  ENTERPRISE_TITLE as TITLE,
  ENTERPRISE_DESCRIPTION as DESC,
} from "@/lib/enterprise-seo";
import { CISO_MAILTO_HREF } from "@/lib/ciso-intake";
import { CisoIntakeActions } from "@/components/ciso-intake-actions";
import "./enterprise.css";

const BASE = import.meta.env.BASE_URL;
const MAIL = CISO_MAILTO_HREF;

const NAV: [string, string, string][] = [
  ["dashboard", "Dashboard", ""],
  ["docs", "Docs", "docs"],
  ["standard", "Standard", "standard"],
  ["simulator", "Enterprise Preview", "simulator"],
  ["whitepaper", "Whitepaper", "whitepaper"],
];

const SECTIONS: {
  id: string;
  kicker: string;
  title: string;
  body: string[];
}[] = [
  {
    id: "licensing",
    kicker: "01 / Licensing and IP",
    title: "Run the engine behind your own firewall",
    body: [
      "The public API and open-source option are governed by AGPLv3. For covered deployments that cannot meet AGPL source-disclosure obligations, an executed Commercial License provides a commercial exemption for the covered software, so you can operate it on private infrastructure without being required to release it under AGPL terms.",
      "AGPLv3 does not automatically force all independent code or model weights to be open-sourced. Your proprietary agent code and model weights stay private, and the Commercial License removes the compliance question for the covered engine itself.",
      "The exemption comes only from an executed commercial agreement. Public API fees and payment credentials do not purchase a software license. Third-party code and data keep their own terms.",
    ],
  },
  {
    id: "article12",
    kicker: "02 / Article 12 logging",
    title: "A Merkle flight recorder for post-hoc reconstruction",
    body: [
      "The engine supports EU AI Act Article 12 automatic logging by committing agent events into a Merkle chain of custody, a cryptographic flight recorder that lets auditors reconstruct what happened after an incident.",
      "Powered by NIP-98 Cryptographic Agent Identity Binding, the engine cryptographically authenticates the signing sub-agent behind each identity-bound request, linking that identity to the Merkle chain of custody for EU AI Act Article 12 logging and post-hoc reconstruction.",
      "Merkle evidence is tamper-evident: any later change to a recorded entry becomes detectable. It does not physically prevent changes, and it is not proof of fault or of regulatory compliance. Compliance remains your determination with counsel.",
      "A Bitcoin anchor is verified only after confirmed inclusion that you or a third party has independently checked. A pending anchor is provisional.",
    ],
  },
  {
    id: "airgap",
    kicker: "03 / Air-gapped operation",
    title: "Internal networks, public anchoring by governed export",
    body: [
      "Internal and air-gapped deployments never connect an isolated device directly to mainnet. Anchoring uses a governed export and import step: evidence digests leave your enclave under your own change control, are anchored publicly, and return as inclusion data for independent verification.",
    ],
  },
];

const CASES = [
  {
    t: "Multi-Vendor Arbitration",
    d: "When agents from several vendors act in one workflow, a shared tamper-evident record gives all parties the same evidence to examine when establishing which agent made a mistake. It supports the inquiry; it does not decide fault.",
  },
  {
    t: "L402 circuit breakers",
    d: "Spending circuit breakers cap L402 payments from a runaway agent. The resulting controls and logs are material a cyber-liability underwriter can review. They are not an insurance guarantee, and coverage terms are set by the insurer.",
  },
];

export default function EnterprisePage() {
  useEffect(() => {
    const prev = document.title;
    document.title = TITLE;
    let m = document.querySelector('meta[name="description"]');
    const old = m?.getAttribute("content") ?? null;
    if (!m) {
      m = document.createElement("meta");
      m.setAttribute("name", "description");
      document.head.appendChild(m);
    }
    m.setAttribute("content", DESC);
    return () => {
      document.title = prev;
      if (old !== null) m!.setAttribute("content", old);
      else m!.remove();
    };
  }, []);

  return (
    <div className="app-shell ent-page">
      <div className="shell-inner">
        <header className="topbar">
          <nav className="ent-nav" aria-label="Primary">
            <Article12VerifierLink />
            {NAV.map(([k, label, path]) => (
              <a
                key={k}
                href={`${BASE}${path}`}
                className="control-button"
                data-testid={`link-${k}`}
              >
                {label}
              </a>
            ))}
            <a
              href={`${BASE}enterprise`}
              className="control-button ent-current"
              aria-current="page"
              data-testid="link-enterprise-license"
            >
              Enterprise License
            </a>
          </nav>
          <div className="eyebrow">
            <span className="eyebrow-line" /> ENTERPRISE / COMMERCIAL LICENSE
          </div>
          <div className="ent-hero">
            <h1>
              Enterprise Swarm Infrastructure.
              <br />
              <span>Secure, Air-Gapped, and Commercially Licensed.</span>
            </h1>
            <p className="subtitle">
              For CISOs protecting private AI swarm IP and needing auditable
              reconstruction of agent activity. Deploy the complete 16-Tool
              Stateless MCP Server (2026-07-28), secured by Ed25519
              Cryptographically Signed Tool Integrity, behind your firewall
              without relying on a third-party MCP proxy.
            </p>
            <div className="ent-cta-row">
              <a href={MAIL} className="ent-cta" data-testid="link-contact-sales">
                Contact Sales for Enterprise Sizing
              </a>
              <CisoIntakeActions testIdPrefix="hero" />
            </div>
          </div>
        </header>

        <main className="ent-main">
          {SECTIONS.map((s) => (
            <section key={s.id} id={s.id} className="panel ent-sec">
              <div className="section-kicker">{s.kicker}</div>
              <h2>{s.title}</h2>
              {s.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </section>
          ))}

          <section id="usecases" className="panel ent-sec">
            <div className="section-kicker">04 / Advanced use cases</div>
            <h2>Evidence for arbitration and underwriting</h2>
            <div className="ent-grid">
              {CASES.map((c) => (
                <div key={c.t} className="ent-card">
                  <h3>{c.t}</h3>
                  <p>{c.d}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="settlement" className="panel ent-sec ent-final">
            <div className="section-kicker">05 / Settlement model</div>
            <h2>Priced to your swarm, settled in one transaction</h2>
            <p>
              Enterprise pricing is customized by swarm size and deployment
              needs, settled securely via a single Bitcoin transaction paid in
              full at the time of execution.
            </p>
            <p>
              Scope, support and deployment rights must be agreed in
              writing. This page is not itself a grant of commercial rights and
              makes no certification claims.
            </p>
            <div className="ent-cta-row">
              <a
                href={MAIL}
                className="ent-cta"
                data-testid="link-contact-sales-bottom"
              >
                Contact Sales for Enterprise Sizing
              </a>
              <CisoIntakeActions testIdPrefix="bottom" />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
