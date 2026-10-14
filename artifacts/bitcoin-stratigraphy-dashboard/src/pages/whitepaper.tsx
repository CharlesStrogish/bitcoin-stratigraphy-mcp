import { useEffect } from "react";
import {
  WHITEPAPER_TITLE as TITLE,
  WHITEPAPER_DESCRIPTION as DESC,
} from "@/lib/whitepaper-seo";
import WhitepaperContent, { WHITEPAPER_SECTIONS } from "./whitepaper-content";
import "./whitepaper.css";

const BASE = import.meta.env.BASE_URL;
const MAIL = "mailto:licensing@bitcoinstratigraphy.com";

const NAV: [string, string, string][] = [
  ["dashboard", "Dashboard", ""],
  ["docs", "Docs", "docs"],
  ["standard", "Standard", "standard"],
  ["simulator", "Enterprise Preview", "simulator"],
  ["enterprise-license", "Enterprise License", "enterprise"],
];

export default function WhitepaperPage() {
  useEffect(() => {
    const prev = document.title;
    document.title = TITLE;
    let m = document.querySelector('meta[name="description"]');
    const old = m?.getAttribute("content") ?? null;
    const created = !m;
    if (!m) {
      m = document.createElement("meta");
      m.setAttribute("name", "description");
      document.head.appendChild(m);
    }
    m.setAttribute("content", DESC);
    return () => {
      document.title = prev;
      if (!created && old !== null) m!.setAttribute("content", old);
      else if (created) m!.remove();
    };
  }, []);

  return (
    <div className="app-shell wp-page">
      <div className="shell-inner">
        <header className="topbar">
          <nav className="wp-nav" aria-label="Primary">
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
              href={`${BASE}whitepaper`}
              className="control-button wp-current"
              aria-current="page"
              data-testid="link-whitepaper"
            >
              Whitepaper
            </a>
          </nav>
        </header>
        <main className="wp-main">
          <section className="panel wp-hero">
            <div className="eyebrow">
              <span className="eyebrow-line" /> TECHNICAL WHITEPAPER
            </div>
            <h1>{TITLE}</h1>
            <nav className="wp-toc" aria-label="On this page">
              {WHITEPAPER_SECTIONS.map((x) => (
                <a
                  key={x.id}
                  href={`#${x.id}`}
                  data-testid={`link-toc-${x.id}`}
                >
                  {x.title}
                </a>
              ))}
            </nav>
          </section>
          <WhitepaperContent />
          <div className="wp-actions">
            <a href={MAIL} className="wp-cta" data-testid="link-contact-sales">
              Contact Sales for Enterprise Sizing
            </a>
            <a
              href={`${BASE}enterprise`}
              className="wp-cta wp-cta-alt"
              data-testid="link-enterprise-licensing"
            >
              View Enterprise Licensing
            </a>
          </div>
        </main>
      </div>
    </div>
  );
}
