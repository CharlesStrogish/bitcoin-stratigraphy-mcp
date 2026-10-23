// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import "./enterprise-licensing-matrix.css";
import { CopyTextButton } from "./copy-text-button";

const LICENSING_EMAIL = "licensing@bitcoinstratigraphy.com";
const INTAKE_HREF =
  "mailto:licensing@bitcoinstratigraphy.com?subject=" +
  encodeURIComponent("CISO Enterprise Licensing Intake");

const COMMUNITY = [
  "AGPLv3 License",
  "Public Network Node",
  "Standard Tool Access",
];

const ENTERPRISE = [
  "Proprietary IP Shield / No Viral Copyleft",
  "Air-Gapped / VPC Deployment",
  "EU AI Act Article 12 & 26(6) Tamper-Evident Flight Recorders",
  "L402 Runaway Swarm Circuit Breakers",
  "Cryptographically Signed Tool Integrity",
  "Automated Compliance SLAs Available",
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
          <p className="elm-tier-label">Tier II</p>
          <h4 id="elm-tier-enterprise">Commercial Enterprise Exemption</h4>
          <p className="elm-price" data-testid="text-enterprise-price">
            <span className="elm-price-from">Starting at</span>
            <span className="elm-price-amount">$250k</span>
            <span className="elm-price-term">/Annual</span>
          </p>
          <ul className="elm-list">
            {ENTERPRISE.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <a
            className="elm-cta"
            href={INTAKE_HREF}
            data-testid="link-enterprise-licensing-intake"
          >
            Request enterprise licensing
            <span aria-hidden="true" className="elm-cta-arrow">
              →
            </span>
          </a>
          <div className="elm-direct-inquiry">
            <span>
              Direct inquiry:{" "}
              <span className="elm-email">{LICENSING_EMAIL}</span>
            </span>
            <CopyTextButton
              text={LICENSING_EMAIL}
              label="Copy"
              context="licensing email address"
              description="Copy licensing email address"
              testId="button-copy-licensing-email"
              variant="compact"
            />
          </div>
        </article>
        <details
          className="elm-risk-brief"
          data-testid="ciso-vendor-risk-brief"
        >
          <summary>CISO Vendor Risk &amp; AGPLv3 Copyleft Brief</summary>
          <div className="elm-risk-content">
            <h5>Protect proprietary swarm IP with Tier II</h5>
            <p>
              The $250,000/year Commercial Enterprise Exemption licenses the
              engine under commercial terms for private VPC and air-gapped
              deployments. Keep proprietary multi-agent weights and enterprise
              logic under your commercial agreement, rather than relying on the
              engine&apos;s AGPLv3 license.
            </p>
            <p>
              AGPLv3 Section 13 requires corresponding source access for covered
              modified software used over a network. It does not automatically
              make independent model weights or unrelated applications subject
              to disclosure. Tier II defines the commercial rights for your
              deployment.
            </p>
            <h5>Automated Compliance SLAs</h5>
            <p>
              Export signed NIP-98 registry snapshots automatically from{" "}
              <code>/api/v1/compliance/revocation-snapshot</code>. Verify issuer
              signatures, snapshot freshness and agent non-revocation at the
              signed timestamp without a network connection.
            </p>
            <p>
              Receipt issuer-key rotation supports independently pinned current
              and historical public keys. The Zero-Trust Article 12 Verifier
              keeps execution evidence inspectable after rotation. Service
              commitments are defined by the signed commercial agreement.
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
