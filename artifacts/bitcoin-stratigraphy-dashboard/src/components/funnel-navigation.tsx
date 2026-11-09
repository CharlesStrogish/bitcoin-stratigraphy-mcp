import { Link, useLocation } from "wouter";
import "@/pages/funnel.css";

const CHOICES = [
  { href: "/developers", label: "Developers", mobileLabel: "API", hint: "MCP integration" },
  { href: "/audit", label: "Enterprise Audit", mobileLabel: "Audit", hint: "Article 12 scan" },
] as const;

export default function FunnelNavigation() {
  const [location] = useLocation();
  return (
    <nav className="fn-nav" aria-label="Primary">
      <a href="/" className="fn-nav-brand" aria-label="Bitcoin Stratigraphy home" data-testid="link-nav-home">
        <span className="fn-nav-brand-text">Bitcoin <em>Stratigraphy</em></span>
        <svg className="fn-nav-mark" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
          <path d="m12 2 9 10-9 10L3 12Z" />
          <path d="m7.5 12 4.5 5 4.5-5-4.5-5Z" />
        </svg>
      </a>
      <div className="fn-nav-choices">
        {CHOICES.map((c) => {
          const active = location === c.href || location.startsWith(`${c.href}/`);
          return (
            <Link
              key={c.href}
              href={c.href}
              className={`fn-nav-link${c.href === "/audit" ? " fn-nav-audit" : ""}${active ? " is-active" : ""}`}
              aria-label={c.label}
              aria-current={active ? "page" : undefined}
              data-testid={`link-nav-${c.href.slice(1)}`}
            >
              <span className="fn-nav-label">{c.label}</span>
              <span className="fn-nav-mobile-label" aria-hidden="true">{c.mobileLabel}</span>
              <span className="fn-nav-hint">{c.hint}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
