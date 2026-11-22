// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import React from "react";

void React;

export default function PrivacyContent({ base = "/" }: { base?: string }) {
  const BASE = base.endsWith("/") ? base : `${base}/`;
  return (
    <div className="app-shell mf-page privacy-page" id="top">
      <div className="grain" aria-hidden="true" />
      <div className="shell-inner">
        <header className="topbar">
          <nav className="mf-nav" aria-label="Primary">
            {[["Dashboard", ""], ["Docs", "docs"], ["Standard", "standard"], ["Security", "security"]].map(([label, path]) => (
              <a key={label} className="control-button" href={`${BASE}${path}`}>{label}</a>
            ))}
            <a className="control-button mf-current" href={`${BASE}privacy`} aria-current="page">Privacy Policy</a>
          </nav>
        </header>
        <main id="privacy-notice">
          <section className="panel mf-hero">
            <div className="eyebrow"><span className="eyebrow-line" /> PRIVACY / SYSTEM RECORDS</div>
            <h1>Privacy Policy</h1>
            <p>A factual notice about the hosted Bitcoin Stratigraphy service. No user accounts. No ad tracking.</p>
          </section>
          <section className="panel privacy-section" id="accounts">
            <h2>Zero user accounts &amp; zero ad tracking</h2>
            <p>The service does not require account registration or passwords. It does not use third-party ad networks or behavioral tracking pixels. Cryptographic authentication and prepaid access credentials are not website accounts.</p>
          </section>
          <section className="panel privacy-section" id="records">
            <h2>Minimal technical &amp; cryptographic records</h2>
            <p>Paid API/MCP execution and self-serve waivers use operational and cryptographic records to verify settlement, prevent abuse and preserve audit trails. Depending on the operation, these include:</p>
            <ul>
              <li>NIP-98 public keys and authentication evidence.</li>
              <li>SHA-256 digests, context hashes, submitted proofs and execution evidence.</li>
              <li>L402 payment hashes, macaroon metadata, request budgets and settlement records.</li>
              <li>IP-based rate-limiting counters and operational request logs.</li>
              <li>Public Bitcoin transaction IDs and waiver settlement addresses.</li>
              <li>Buyer-supplied licensee names and identifiers included in AGPLv3 Waiver Certificates.</li>
            </ul>
            <p>Do not submit unnecessary personal information or secrets as tool inputs. This notice does not promise deletion of audit evidence or a fixed retention period.</p>
          </section>
          <section className="panel privacy-section" id="processors">
            <h2>Optional card checkout &amp; delivery email</h2>
            <p>Optional credit-card scanner checkout is processed by <a href="https://stripe.com/privacy" rel="noopener noreferrer" target="_blank">Stripe</a>. Automated delivery emails are dispatched via <a href="https://www.brevo.com/legal/privacypolicy/" rel="noopener noreferrer" target="_blank">Brevo</a>, under their respective privacy policies. BitcoinStratigraphy.com does not store raw credit card numbers.</p>
            <p>For this optional rail, the service retains the recipient email address, order and checkout-session identifiers, and delivery status needed to fulfill the purchase and prevent duplicate delivery. These records are separate from ad tracking.</p>
            <p>Native Bitcoin/Lightning payments and on-chain waiver payments do not require card intermediaries. The server does not hold Bitcoin private spending keys: wallet signing stays with connected wallets, while on-chain waiver receiving addresses use watch-only public key derivation. Configured wallet authorizations can permit server-requested wallet operations.</p>
          </section>
          <section className="panel privacy-section" id="public-ledger">
            <h2>Public Bitcoin records &amp; self-hosting</h2>
            <p>Confirmed on-chain waiver transactions and Bitcoin commitments used by OpenTimestamps are public and permanent by the nature of the Bitcoin ledger. Calendar acceptance alone is not Bitcoin confirmation. A timestamp commitment does not itself publish the original document or a licensee name on-chain.</p>
            <p>Organizations that need isolated processing may self-host the <a href="https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp" rel="noopener noreferrer" target="_blank">AGPLv3 codebase</a> in a private VPC or air-gapped environment. Isolation depends on the deployment: public Bitcoin anchoring still requires an approved export/import process, and optional payment, email and network services require their respective connections.</p>
          </section>
          <section className="panel privacy-section" id="scope">
            <h2>AS-IS scope &amp; zero service obligations</h2>
            <p>This notice describes factual system telemetry. It does not create custom DPAs, SLAs, vendor questionnaires or support obligations.</p>
            <p>All prepaid MCP Macro-Macaroons, Scanner Packs, and AGPLv3 Commercial Copyright Waivers are 100% self-serve and provided STRICTLY AS-IS, WITH ALL FAULTS. Zero SLAs, zero uptime warranties, zero indemnity, zero custom MSAs, zero vendor questionnaires, and zero support obligations. Full source code is publicly inspectable under AGPLv3 for independent self-hosting. Payment for a Commercial Copyright Waiver strictly grants a time-locked, non-negotiable waiver from AGPLv3 Section 13 network source-disclosure requirements for the specified term, anchored cryptographically to your confirmed Bitcoin transaction.</p>
            <p>See <a href="https://bitcoinstratigraphy.com/#enterprise-licensing">enterprise licensing</a> and the <a href="https://bitcoinstratigraphy.com/security">security report</a>.</p>
          </section>
        </main>
      </div>
    </div>
  );
}
