// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import "./enterprise-licensing-matrix.css";
import { WaiverPurchase, WAIVER_DISCLOSURE } from "./waiver-purchase";

const COMMUNITY = [
  "AGPLv3 License",
  "Public Network Node",
  "Standard Tool Access",
];

const ENTERPRISE = [
  "Time-Locked AGPLv3 Section 13 Waiver",
  "Self-Hosted Air-Gapped / VPC Deployment",
  "EU AI Act Article 12 & 26(6) Tamper-Evident Flight Recorders",
  "L402 Runaway Swarm Circuit Breakers",
  "Cryptographically Signed Tool Integrity",
  "Ed25519-Signed Waiver Certificate, Verifiable Offline",
];

export function EnterpriseLicensingMatrix() {
  return (
    <section
      id="enterprise-licensing"
      className="elm"
      aria-labelledby="cc-licensing-title"
      data-testid="module-enterprise-licensing"
    >
      <header className="elm-head">
        <div className="section-kicker">
          02 · DUAL-LICENSING &amp; COMPLIANCE MATRIX
        </div>
        <h3 id="cc-licensing-title">
          Enterprise Licensing &amp; Compliance Architecture
        </h3>
      </header>

      <div className="elm-grid">
        <article
          className="elm-tier"
          aria-labelledby="elm-tier-community"
          data-testid="card-tier-community"
        >
          <p className="elm-tier-label">Tier I</p>
          <h4 id="elm-tier-community">Community Open Source</h4>
          <p className="elm-price elm-price-muted">AGPLv3</p>
          <ul className="elm-list">
            {COMMUNITY.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </article>

        <article
          className="elm-tier elm-tier-enterprise"
          aria-labelledby="elm-tier-enterprise"
          data-testid="card-tier-enterprise"
        >
          <p className="elm-tier-label">Self-serve Bitcoin waiver</p>
          <h4 id="elm-tier-enterprise">AGPLv3 Commercial Copyright Waiver</h4>
          <p className="elm-price" data-testid="text-enterprise-price">
            <span className="elm-price-from">From</span>
            <span className="elm-price-amount">$2,500</span>
            <span className="elm-price-term">/30 days in BTC</span>
          </p>
          <ul className="elm-list">
            {ENTERPRISE.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <WaiverPurchase />
        </article>
        <details
          className="elm-risk-brief"
          data-testid="ciso-vendor-risk-brief"
        >
          <summary>CISO Vendor Risk &amp; AGPLv3 Copyleft Brief</summary>
          <div className="elm-risk-content">
            <h5>What the waiver covers</h5>
            <p>
              A confirmed Bitcoin payment against a locked quote mints an
              Ed25519-signed certificate waiving AGPLv3 Section 13 network
              source-disclosure requirements for the purchased term. Single-Swarm
              tiers cover one swarm; Global Organization tiers cover the
              licensee organization.
            </p>
            <p>
              AGPLv3 Section 13 requires corresponding source access for covered
              modified software used over a network. It does not automatically
              make independent model weights or unrelated applications subject
              to disclosure.
            </p>
            <h5>AS-IS protocol terms</h5>
            <p data-testid="text-risk-brief-disclosure">{WAIVER_DISCLOSURE}</p>
            <h5>Offline evidence</h5>
            <p>
              Export signed NIP-98 registry snapshots from{" "}
              <code>/api/v1/compliance/revocation-snapshot</code>. Verify issuer
              signatures, snapshot freshness and agent non-revocation at the
              signed timestamp without a network connection. Receipt issuer-key
              rotation supports independently pinned current and historical
              public keys.
            </p>
          </div>
        </details>
      </div>
      <a
        className="elm-integrity-link"
        href="/.well-known/integrity.json"
        data-testid="link-tool-integrity-manifest"
      >
        View Tool Integrity Manifest
      </a>
    </section>
  );
}
