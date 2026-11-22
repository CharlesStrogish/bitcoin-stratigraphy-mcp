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
        <span className="fn-nav-brand-text"><img src={`${import.meta.env.BASE_URL}favicon-32x32.png`} width="32" height="32" alt="" style={{ display: "inline-block", verticalAlign: "middle", marginRight: 8, objectFit: "contain" }} />Bitcoin <em>Stratigraphy</em></span>
        <img className="fn-nav-mark" src={`${import.meta.env.BASE_URL}favicon-32x32.png`} width="32" height="32" alt="" style={{ objectFit: "contain" }} />
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
