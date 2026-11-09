import React from "react";
/** Shared public copy, safe to render at build time without payment clients. */
export function AuditIntro() {
  return (
    <header className="fn-hero fn-rise">
      <p className="fn-kicker">Enterprise / EU AI Act Article 12</p>
      <h1 className="fn-title">Article 12 <span>Vulnerability Scanner</span></h1>
      <p className="fn-lede">
        Submit a system prompt or agent transcript. A heuristic scan flags record-keeping risk in
        biometric data handling, financial execution and autonomous deployment.
      </p>
    </header>
  );
}

export default function AuditCrawlerContent() {
  return (
    <main className="fn-page fn-page-audit">
      <div className="fn-shell fn-shell-narrow">
        <AuditIntro />
        <section className="fn-kiosk">
          <h2>Run Compliance Scan</h2>
          <p>Paste your AI prompt, review the Lightning invoice, then pay using your phone wallet.</p>
          <p>The backend verifies settlement before releasing your risk report. The report includes an overall Low, Medium or High risk level, flagged categories and a SHA-256 Compliance Hash.</p>
          <p>This keyword heuristic supports evidence review, not legal certification. The simulated receipt is not a zero-knowledge proof or Bitcoin timestamp. Enable JavaScript to use the secure payment kiosk.</p>
        </section>
        <nav aria-label="Primary">
          <a href="/developers/">Developers</a>{" / "}
          <a href="/audit/" aria-current="page">Enterprise Audit</a>
        </nav>
      </div>
    </main>
  );
}
