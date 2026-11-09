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
      <Link href="/" className="fn-nav-brand" aria-label="Bitcoin Stratigraphy home" data-testid="link-nav-home">
        <span className="fn-nav-brand-text">Bitcoin <em>Stratigraphy</em></span>
      </Link>
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
