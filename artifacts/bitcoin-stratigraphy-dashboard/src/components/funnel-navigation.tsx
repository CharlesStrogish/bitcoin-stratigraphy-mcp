import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { Link, useLocation } from "wouter";
import "@/pages/funnel.css";

const CHOICES = [
  { href: "/developers", label: "Developers", hint: "MCP integration" },
  { href: "/audit", label: "Enterprise Audit", hint: "Article 12 scan" },
] as const;

export default function FunnelNavigation() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 769px)");
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      if (!nav.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && nav.current?.contains(document.activeElement)) {
        close();
        toggle.current?.focus();
      }
    };
    desktop.addEventListener("change", close);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      desktop.removeEventListener("change", close);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => setOpen(false), [location]);

  return (
    <nav
      ref={nav}
      className="fn-nav"
      aria-label="Primary"
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Link href="/" className="fn-nav-brand" data-testid="link-nav-home">
        Bitcoin <em>Stratigraphy</em>
      </Link>
      <button
        ref={toggle}
        type="button"
        className="fn-nav-toggle"
        aria-label={open ? "Close main menu" : "Open main menu"}
        aria-expanded={open}
        aria-controls="primary-navigation-links"
        onClick={() => setOpen((value) => !value)}
        data-testid="button-nav-menu"
      >
        {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
      </button>
      <div id="primary-navigation-links" className={`fn-nav-choices${open ? " is-open" : ""}`}>
        {CHOICES.map((c) => {
          const active = location === c.href || location.startsWith(`${c.href}/`);
          return (
            <Link
              key={c.href}
              href={c.href}
              className={`fn-nav-link${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => setOpen(false)}
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
