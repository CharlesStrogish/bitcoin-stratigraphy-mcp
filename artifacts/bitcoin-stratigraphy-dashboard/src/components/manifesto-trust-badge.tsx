// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import React, { useState } from "react";

const BADGE_URL =
  "https://img.shields.io/badge/Secured_by-Bitcoin_Stratigraphy-F7931A?style=for-the-badge&logo=bitcoin&logoColor=white";
const BADGE_MARKDOWN = `[![Secured by Bitcoin Stratigraphy](${BADGE_URL})](https://bitcoinstratigraphy.com)`;

export default function ManifestoTrustBadge() {
  const [copyStatus, setCopyStatus] = useState("");

  async function copyMarkdown() {
    try {
      await navigator.clipboard.writeText(BADGE_MARKDOWN);
      setCopyStatus("Markdown copied.");
    } catch {
      setCopyStatus("Copy unavailable. Select and copy the Markdown below.");
    }
  }

  return (
    <section id="fiduciary-trust-badge" className="mf-trust-badge">
      <h2>8. The Fiduciary Trust Badge</h2>
      <p>
        Developers utilizing our L402 circuit breakers and Ed25519 Truth Receipts
        can display the official trust badge on their repositories to guarantee
        Article 12 compliance to their users.
      </p>
      <a href="https://bitcoinstratigraphy.com" aria-label="Bitcoin Stratigraphy">
        <img
          src={BADGE_URL}
          alt="Secured by Bitcoin Stratigraphy"
          className="mf-trust-badge-preview"
        />
      </a>
      <div className="mf-badge-copy">
        <button
          type="button"
          className="control-button"
          onClick={copyMarkdown}
          aria-describedby="badge-copy-status"
        >
          Copy Markdown
        </button>
        <span id="badge-copy-status" role="status">{copyStatus}</span>
      </div>
      <pre tabIndex={0} aria-label="Trust badge Markdown">
        <code>{BADGE_MARKDOWN}</code>
      </pre>
    </section>
  );
}
