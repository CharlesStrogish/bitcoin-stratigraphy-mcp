import { type MouseEvent, useEffect } from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Check, FileText, KeyRound, LayoutGrid, Play, ScrollText, ShieldCheck, Terminal, Zap } from "lucide-react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter } from "wouter";
import NotFound from "@/pages/not-found";
import EnterprisePage from "@/pages/enterprise";
import EnterpriseLicenseLink from "@/components/enterprise-license-link";
import WhitepaperPage from "@/pages/whitepaper";
import ManifestoPage from "@/pages/manifesto";
import SecurityPage from "@/pages/security";
import CeremonyPage from "@/pages/ceremony";
import WhitepaperLink from "@/components/whitepaper-link";
import SiteFooter from "@/components/site-footer";
import Article12VerifierLink from "@/components/article12-verifier-link";
import StandardPage from "@/pages/standard";
import SimulatorPage from "@/pages/simulator";
import CompliancePage from "@/pages/compliance";
import ComplianceGuideLink from "@/components/compliance-guide-link";
import { EscrowTerminal } from "@/simulator/components/EscrowTerminal";
import { TrustBadges } from "@/components/trust-badges";
import { PublicRouteHead } from "@/components/public-route-head";
import { Article12Sandbox } from "@/components/article12-sandbox";
import "@/pages/funnel.css";
import { CommandCenter } from "@/components/command-center/command-center";
import FunnelNavigation from "@/components/funnel-navigation";
import DevelopersPage from "@/pages/developers";
import AuditPage from "@/pages/audit";
import PrepaidApiAccess from "@/components/prepaid-api-access";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false },
  },
});

const LIVE_ESCROW_TERMINAL_ID = "live-escrow-terminal";
const LIVE_ESCROW_HASH = `#${LIVE_ESCROW_TERMINAL_ID}`;

function revealLiveEscrowTerminal() {
  const terminal = document.getElementById(LIVE_ESCROW_TERMINAL_ID);
  if (!terminal) return;
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  terminal.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
  // Native in-page links move keyboard focus with the scroll; keep that parity.
  terminal.focus({ preventScroll: true });
}

function jumpToLiveEscrowTerminal(event: MouseEvent<HTMLAnchorElement>) {
  // Modified clicks keep their browser meaning, such as opening a new tab.
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  if (window.location.hash !== LIVE_ESCROW_HASH) {
    window.history.pushState(null, "", LIVE_ESCROW_HASH);
  }
  revealLiveEscrowTerminal();
}

function Header() {
  return (
    <header className="topbar">
      <div className="eyebrow">
        <span className="eyebrow-line" /> ENTERPRISE MCP SERVER / L402 ORACLE
      </div>
      <div className="header-main homepage-header-main">
        <div>
          <h1>
            Bitcoin <span>Stratigraphy</span>
          </h1>
          <h2 className="subtitle">
            Enterprise-grade L402 data engine and cryptographic notary hub.
            Providing State-Anchored AI data layers and Swarm Flight Recorders
            for EU AI Act Article 12 compliance — Created &amp; Architected by
            Charles R. Strogish.
            <br />
            Anchoring autonomous agents in thermodynamic truth to mathematically eliminate hallucinations.
          </h2>
          <TrustBadges />
        </div>
        <div className="header-actions homepage-actions">
          <a
            className="control-button live-escrow-button"
            href={LIVE_ESCROW_HASH}
            onClick={jumpToLiveEscrowTerminal}
            data-testid="link-live-escrow"
          >
            <Zap size={14} /> Live REST Escrow
          </a>
          <EnterpriseLicenseLink />
          <Article12VerifierLink />
          <WhitepaperLink />
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}#article12-sandbox`}
            data-testid="link-article12-sandbox"
          >
            <Terminal size={14} aria-hidden="true" /> Art. 12 Sandbox
          </a>
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}manifesto`}
            data-testid="link-home-manifesto"
          >
            <ScrollText size={14} aria-hidden="true" /> Manifesto
          </a>
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}security`}
            data-testid="link-home-security"
          >
            <ShieldCheck size={14} aria-hidden="true" /> Security Audit
          </a>
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}ceremony`}
            data-testid="link-home-ceremony"
          >
            <KeyRound size={14} aria-hidden="true" /> Setup Ceremony
          </a>
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}docs`}
          >
            <FileText size={14} /> Developer docs
          </a>
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}blog/`}
            data-testid="link-home-blog"
          >
            <FileText size={14} aria-hidden="true" /> Engineering blog
          </a>
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}standard`}
            data-testid="link-standard"
          >
            <Check size={14} /> SA-AI standard
          </a>
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}simulator`}
            data-testid="link-simulator"
          >
            <Play size={14} /> Enterprise preview
          </a>
          <a
            className="control-button"
            href="#mcp-tools"
            data-testid="link-tool-catalog"
          >
            <LayoutGrid size={14} aria-hidden="true" /> 19-Tool Capacity
          </a>
        </div>
      </div>
    </header>
  );
}

function Home() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);
  useEffect(() => {
    let frame = 0;
    const revealFromHash = () => {
      if (window.location.hash !== LIVE_ESCROW_HASH) return;
      cancelAnimationFrame(frame);
      // Two frames: measure the terminal only after the committed layout.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(revealLiveEscrowTerminal);
      });
    };
    revealFromHash();
    window.addEventListener("hashchange", revealFromHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", revealFromHash);
    };
  }, []);
  return (
    <div className="app-shell">
      <div className="grain" />
      <div className="shell-inner">
        <Header />
        <section
          id={LIVE_ESCROW_TERMINAL_ID}
          className="live-escrow-section"
          tabIndex={-1}
          data-testid="section-escrow-terminal"
        >
          <ComplianceGuideLink />
          <EscrowTerminal />
        </section>
        <Article12Sandbox />
        <main>
          <CommandCenter />
        </main>
      </div>
    </div>
  );
}

function Router() {
  return (
    <ErrorBoundary>
      <FunnelNavigation />
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/standard" component={StandardPage} />
        <Route path="/enterprise" component={EnterprisePage} />
        <Route path="/whitepaper" component={WhitepaperPage} />
        <Route path="/manifesto" component={ManifestoPage} />
        <Route path="/security" component={SecurityPage} />
        <Route path="/ceremony" component={CeremonyPage} />
        <Route path="/simulator" component={SimulatorPage} />
        <Route path="/compliance" component={CompliancePage} />
        <Route path="/developers">{() => <DevelopersPage prepaidAccess={<PrepaidApiAccess />} />}</Route>
        <Route path="/audit">{() => <AuditPage />}</Route>
        <Route component={NotFound} />
      </Switch>
      <PublicRouteHead />
      <SiteFooter />
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
