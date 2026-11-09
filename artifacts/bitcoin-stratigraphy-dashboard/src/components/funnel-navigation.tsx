import { Link, useLocation } from "wouter";
import "@/pages/funnel.css";

const CHOICES = [
  { href: "/developers", label: "Developers", hint: "MCP integration" },
  { href: "/audit", label: "Enterprise Audit", hint: "Article 12 scan" },
] as const;

export default function FunnelNavigation() {
  const [location] = useLocation();
  return (
    <nav className="fn-nav" aria-label="Primary">
      <Link href="/" className="fn-nav-brand" data-testid="link-nav-home">
        <span className="fn-nav-mark" aria-hidden="true" />
        Bitcoin <em>Stratigraphy</em>
      </Link>
      <div className="fn-nav-choices">
        {CHOICES.map((c) => {
          const active = location === c.href || location.startsWith(`${c.href}/`);
          return (
            <Link
              key={c.href}
              href={c.href}
              className={`fn-nav-link${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              data-testid={`link-nav-${c.href.slice(1)}`}
            >
              <span className="fn-nav-label">{c.label}</span>
              <span className="fn-nav-hint">{c.hint}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
