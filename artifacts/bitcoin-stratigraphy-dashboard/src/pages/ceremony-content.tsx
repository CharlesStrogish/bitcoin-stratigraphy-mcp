// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import React from "react";
import MarkdownDocument, { parseMarkdown, slugify } from "../components/markdown-document";

const NAV: [string, string, string][] = [
  ["dashboard", "Dashboard", ""],
  ["standard", "Standard", "standard"],
  ["whitepaper", "Whitepaper", "whitepaper"],
  ["manifesto", "Manifesto", "manifesto"],
  ["security", "Security", "security"],
];

void React;
export default function CeremonyContent({
  markdown,
  base = "/",
}: { markdown: string; base?: string }) {
  const BASE = base.endsWith("/") ? base : `${base}/`;
  const blocks = parseMarkdown(markdown);
  const title = blocks[0]?.kind === "heading" ? blocks[0].text : "";
  const sections = blocks.flatMap((b) => (b.kind === "heading" && b.level === 2 ? [b.text] : []));

  return (
    <div className="app-shell mf-page cr-page" id="top">
      <div className="grain" />
      <div className="shell-inner">
        <header className="topbar">
          <nav className="mf-nav" aria-label="Primary">
            {NAV.map(([id, label, path]) => (
              <a key={id} href={`${BASE}${path}`} className="control-button" data-testid={`link-${id}`}>
                {label}
              </a>
            ))}
            <a href={`${BASE}ceremony`} className="control-button mf-current" aria-current="page" data-testid="link-ceremony">
              Ceremony
            </a>
          </nav>
        </header>
        <main>
          <section className="panel cr-hero" aria-labelledby="cr-ethos">
            <div className="eyebrow">
              <span className="eyebrow-line" /> OFFICIAL ETHOS / FIDUCIARY CENTRAL BANK
            </div>
            <figure className="cr-quote">
              <blockquote id="cr-ethos" data-testid="text-ethos">
                <p>&ldquo;Alienate no one while upgrading everyone.&rdquo;</p>
              </blockquote>
              <figcaption>Official ethos of the Fiduciary Central Bank</figcaption>
            </figure>
            <div className="cr-hero-foot">
              <div>
                <div className="section-kicker">Recruiting independent phase-two contributors</div>
                <h1 className="cr-title">{title}</h1>
              </div>
              <ol className="cr-strata" aria-label="Contribution sequence">
                {["0000", "0001", "0002", "0003"].map((n, idx) => (
                  <li key={n}>
                    <span>{idx === 0 ? "start" : `P${idx}`}</span>
                    <code>circuit_{n}.zkey</code>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <div className="mf-layout">
            <nav className="mf-toc" aria-label="On this page">
              <p className="mf-toc-label">Contents</p>
              <ol>
                {sections.map((s, n) => (
                  <li key={s}>
                    <a href={`#${slugify(s)}`} data-testid={`link-toc-${slugify(s)}`}>
                      <span className="mf-toc-num">{n + 1}</span>
                      {s}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            <article className="mf-article cr-article">
              <p className="cr-source">
                Source: <code>circuits/MPC_CEREMONY.md</code> &mdash; reproduced verbatim.
              </p>
              <MarkdownDocument markdown={markdown} skipFirstHeading />
              <a href="#top" className="mf-top">Back to top</a>
            </article>
          </div>
        </main>
      </div>
    </div>
  );
}
