import { type MouseEvent, useEffect, useMemo } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type { StratigraphyEntry } from "@workspace/api-client-react";
import stratigraphyDataset from "../../api-server/data/stratigraphy.json";
import {
  Check,
  Database,
  Download,
  FileText,
  Play,
  RefreshCw,
  Zap,
} from "lucide-react";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter } from "wouter";
import NotFound from "@/pages/not-found";
import EnterprisePage from "@/pages/enterprise";
import EnterpriseLicenseLink from "@/components/enterprise-license-link";
import WhitepaperPage from "@/pages/whitepaper";
import WhitepaperLink from "@/components/whitepaper-link";
import SiteFooter from "@/components/site-footer";
import StandardPage from "@/pages/standard";
import SimulatorPage from "@/pages/simulator";
import CompliancePage from "@/pages/compliance";
import ComplianceGuideLink from "@/components/compliance-guide-link";
import { EscrowTerminal } from "@/simulator/components/EscrowTerminal";
import { TrustBadges } from "@/components/trust-badges";
import { PublicRouteHead } from "@/components/public-route-head";
import { CommandCenter } from "@/components/command-center/command-center";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false },
  },
});

const EXPECTED_DATASET_LENGTH = 422;
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

type RawStratigraphyEntry = Omit<StratigraphyEntry, "quantitative_alpha"> & {
  quantitative_alpha?: Partial<StratigraphyEntry["quantitative_alpha"]>;
};

function supplyQuantitativeAlpha(
  entry: RawStratigraphyEntry,
  previousMultiplier: number,
): StratigraphyEntry {
  const match = /(\d+(?:\.\d+)?)\s*[x×]\s*away/i.exec(entry.title);
  const derivedMultiplier = match ? Number(match[1]) : 0;
  const multiplier =
    typeof entry.quantitative_alpha?.target_multiplier === "number"
      ? entry.quantitative_alpha.target_multiplier
      : derivedMultiplier || previousMultiplier;

  return {
    ...entry,
    quantitative_alpha: {
      target_multiplier: multiplier,
      difficulty_epoch_progress:
        entry.quantitative_alpha?.difficulty_epoch_progress ??
        `${(((((entry.day - 1) % 14) + 1) / 14) * 100).toFixed(2)}%`,
      thermodynamic_signal:
        entry.quantitative_alpha?.thermodynamic_signal ??
        (multiplier >= 120
          ? "extended-target-distance"
          : multiplier >= 100
            ? "elevated-target-distance"
            : multiplier > 0
              ? "compressed-target-distance"
              : "signal-unavailable"),
    },
  };
}

let previousMultiplier = 0;
const completeDataset = (stratigraphyDataset as RawStratigraphyEntry[]).map(
  (entry) => {
    const suppliedEntry = supplyQuantitativeAlpha(entry, previousMultiplier);
    previousMultiplier = suppliedEntry.quantitative_alpha.target_multiplier;
    return suppliedEntry;
  },
);

async function loadCompleteDataset() {
  if (
    completeDataset.length !== EXPECTED_DATASET_LENGTH ||
    completeDataset[0]?.day !== 1 ||
    completeDataset.at(-1)?.day !== EXPECTED_DATASET_LENGTH
  ) {
    throw new Error("The primary stratigraphy dataset is incomplete");
  }
  return completeDataset;
}

function formatDay(day: number) {
  return String(day).padStart(3, "0");
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCsv(rows: StratigraphyEntry[]) {
  const header = ["day", "title", "video_id", "transcript_summary"];
  const body = rows.map((row) =>
    [row.day, row.title, row.video_id, row.transcript_summary]
      .map(csvCell)
      .join(","),
  );
  const blob = new Blob([[header.join(","), ...body].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "bitcoin-stratigraphy.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function getSignals(title: string) {
  const text = title.toLowerCase();
  const result: string[] = [];
  if (text.includes("million") || text.includes("$10m") || text.includes("10m"))
    result.push("10M framing");
  if (text.includes("price") || text.includes("dollar") || text.includes("$"))
    result.push("price thesis");
  if (text.includes("halving") || text.includes("cycle"))
    result.push("cycle marker");
  if (text.includes("prediction") || text.includes("forecast"))
    result.push("forecast");
  if (text.includes("day") || text.includes("update"))
    result.push("series note");
  return result.length ? result : ["general signal"];
}

function Header({
  onRefresh,
  onExport,
  refreshing,
  lastRefreshed,
  rowCount,
}: {
  onRefresh: () => void;
  onExport: () => void;
  refreshing: boolean;
  lastRefreshed: string | null;
  rowCount: number;
}) {
  return (
    <header className="topbar">
      <div className="eyebrow">
        <span className="eyebrow-line" /> RESEARCH DESK / BTC-STRATIGRAPHY
      </div>
      <div className="header-main">
        <div>
          <h1>
            Bitcoin <span>Stratigraphy</span>
          </h1>
          <p className="subtitle">
            Enterprise-grade L402 data engine and cryptographic notary hub.
            Providing State-Anchored AI data layers and Swarm Flight Recorders
            for EU AI Act Article 12 compliance — Created &amp; Architected by
            Charles R. Strogish.
          </p>
          <div className="source-row">
            <span className="source-badge">
              <Database size={12} /> Uploaded JSON
            </span>
            <span className="source-caption">
              {rowCount ? `${rowCount} records in view` : "Awaiting dataset"}
            </span>
            {lastRefreshed && (
              <span className="source-caption">Updated {lastRefreshed}</span>
            )}
          </div>
          <TrustBadges />
        </div>
        <div className="header-actions">
          <a
            className="control-button live-escrow-button"
            href={LIVE_ESCROW_HASH}
            onClick={jumpToLiveEscrowTerminal}
            data-testid="link-live-escrow"
          >
            <Zap size={14} /> Live REST Escrow
          </a>
          <EnterpriseLicenseLink />
          <WhitepaperLink />
          <a
            className="control-button"
            href={`${import.meta.env.BASE_URL}docs`}
          >
            <FileText size={14} /> Developer docs
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
          <button
            className="control-button"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : ""} /> Refresh
          </button>
          <button
            className="control-button"
            onClick={onExport}
            disabled={!rowCount}
          >
            <Download size={14} /> CSV
          </button>
          <button
            className="icon-button"
            onClick={() => window.print()}
            aria-label="Export as PDF"
            title="Export as PDF"
            disabled={!rowCount}
          >
            <FileText size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}

function StatCard({
  label,
  value,
  detail,
  accent = "gold",
}: {
  label: string;
  value: string;
  detail: string;
  accent?: string;
}) {
  return (
    <div className={`stat-card stat-${accent}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-detail">{detail}</div>
    </div>
  );
}

function Home() {
  const query = useQuery({
    queryKey: ["stratigraphy", "complete-primary-dataset"],
    queryFn: loadCompleteDataset,
    staleTime: Infinity,
  });
  const allRows = query.data || [];
  const loading = query.isLoading || query.isFetching;
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
  const stats = useMemo(() => {
    const days = allRows.map((entry) => entry.day);
    const signals = allRows.filter((entry) =>
      getSignals(entry.title).includes("10M framing"),
    ).length;
    return {
      first: Math.min(...days),
      last: Math.max(...days),
      signals,
      density: allRows.length
        ? Math.round((signals / allRows.length) * 100)
        : 0,
    };
  }, [allRows]);
  const lastRefreshed = query.dataUpdatedAt
    ? new Date(query.dataUpdatedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  return (
    <div className="app-shell">
      <div className="grain" />
      <div className="shell-inner">
        <Header
          onRefresh={() => query.refetch()}
          onExport={() => downloadCsv(allRows)}
          refreshing={query.isFetching}
          lastRefreshed={lastRefreshed}
          rowCount={allRows.length}
        />
        {query.isError ? (
          <div className="error-state panel">
            <div className="empty-glyph">
              <RefreshCw size={20} />
            </div>
            <strong>Dataset connection interrupted</strong>
            <span>We couldn't read the uploaded JSON right now.</span>
            <button className="reset-button" onClick={() => query.refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="stats-row">
            <StatCard
              label="INDEXED ENTRIES"
              value={loading ? "—" : allRows.length.toLocaleString()}
              detail={
                loading
                  ? "Reading dataset"
                  : `${allRows.length.toLocaleString()} total in source`
              }
            />
            <StatCard
              label="STRATA SPAN"
              value={
                loading || !allRows.length
                  ? "—"
                  : `${formatDay(stats.first)}–${formatDay(stats.last)}`
              }
              detail="Indexed day range"
              accent="rust"
            />
            <StatCard
              label="10M SIGNAL"
              value={loading ? "—" : `${stats.density}%`}
              detail={
                loading
                  ? "Calculating signals"
                  : `${stats.signals} titles reference the thesis`
              }
              accent="teal"
            />
            <StatCard
              label="SERIES COMPLETION"
              value={
                loading || !allRows.length
                  ? "—"
                  : `${Math.round((allRows.length / 422) * 100)}%`
              }
              detail="Of 422 planned day layers"
              accent="slate"
            />
          </div>
        )}
        <section
          id={LIVE_ESCROW_TERMINAL_ID}
          className="live-escrow-section"
          tabIndex={-1}
          data-testid="section-escrow-terminal"
        >
          <ComplianceGuideLink />
          <EscrowTerminal />
        </section>
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
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/standard" component={StandardPage} />
        <Route path="/enterprise" component={EnterprisePage} />
        <Route path="/whitepaper" component={WhitepaperPage} />
        <Route path="/simulator" component={SimulatorPage} />
        <Route path="/compliance" component={CompliancePage} />
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
