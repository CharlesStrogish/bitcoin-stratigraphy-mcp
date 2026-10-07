import { useEffect, useMemo, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type { StratigraphyEntry } from "@workspace/api-client-react";
import stratigraphyDataset from "../../api-server/data/stratigraphy.json";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  ExternalLink,
  FileText,
  Filter,
  Layers3,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter } from "wouter";
import NotFound from "@/pages/not-found";
import StandardPage from "@/pages/standard";
import SimulatorPage from "@/pages/simulator";
import { TrustBadges } from "@/components/trust-badges";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false },
  },
});

const CHART_COLORS = ["#d99a16", "#b9533c", "#3f766a", "#53657d", "#c57b3d"];
const PAGE_SIZE = 10;
const EXPECTED_DATASET_LENGTH = 422;

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
  anchor.download = "bitcoin-stratigraphy-filtered.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function Signal({
  children,
  tone = "gold",
}: {
  children: React.ReactNode;
  tone?: "gold" | "rust" | "teal";
}) {
  return <span className={`signal signal-${tone}`}>{children}</span>;
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
            Providing State-Anchored AI data layers and Swarm Flight Recorders for
            EU AI Act Article 12 compliance — Created &amp; Architected by Charles
            R. Strogish.
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
            <Play size={14} /> Swarm simulator
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

function FilterRail({
  search,
  setSearch,
  minDay,
  setMinDay,
  maxDay,
  setMaxDay,
  reset,
  total,
  filtered,
}: {
  search: string;
  setSearch: (value: string) => void;
  minDay: string;
  setMinDay: (value: string) => void;
  maxDay: string;
  setMaxDay: (value: string) => void;
  reset: () => void;
  total: number;
  filtered: number;
}) {
  const hasFilters = Boolean(search || minDay || maxDay);
  return (
    <aside className="filter-rail">
      <div className="rail-heading">
        <div className="section-kicker">
          <Filter size={13} /> Scope
        </div>
        {hasFilters && (
          <button className="clear-link" onClick={reset}>
            <X size={12} /> Clear
          </button>
        )}
      </div>
      <div className="rail-count">
        <strong>{filtered.toLocaleString()}</strong>
        <span> / {total.toLocaleString()} entries</span>
      </div>
      <div className="rail-section">
        <label htmlFor="search">Search the strata</label>
        <div className="search-wrap">
          <Search size={15} />
          <input
            id="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title, video ID, summary..."
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </div>
        <p className="field-hint">Search all text fields</p>
      </div>
      <div className="rail-section">
        <label>Day range</label>
        <div className="range-row">
          <input
            aria-label="Minimum day"
            inputMode="numeric"
            type="number"
            min="1"
            max="422"
            placeholder="01"
            value={minDay}
            onChange={(event) => setMinDay(event.target.value)}
          />
          <span>to</span>
          <input
            aria-label="Maximum day"
            inputMode="numeric"
            type="number"
            min="1"
            max="422"
            placeholder="422"
            value={maxDay}
            onChange={(event) => setMaxDay(event.target.value)}
          />
        </div>
        <div className="range-track">
          <span
            style={{
              left: `${Math.max(0, Math.min(100, ((Number(minDay) || 1) / 422) * 100))}%`,
              right: `${Math.max(0, 100 - ((Number(maxDay) || 422) / 422) * 100)}%`,
            }}
          />
        </div>
        <p className="field-hint">Series runs from day 1 to day 422</p>
      </div>
      <div className="rail-section rail-note">
        <div className="note-mark">
          <Layers3 size={14} />
        </div>
        <div>
          <strong>Read the layers</strong>
          <p>
            Use title signals to track how the $10M thesis changes over time.
          </p>
        </div>
      </div>
      <button className="reset-button" onClick={reset} disabled={!hasFilters}>
        Reset all filters
      </button>
      <div className="rail-footer">
        <CircleHelp size={13} /> Tip: sort any column to surface a pattern
      </div>
    </aside>
  );
}

function SortButton({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction?: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <button
      className={`sort-button ${active ? "sort-active" : ""}`}
      onClick={onClick}
    >
      {label}
      {active ? (
        direction === "asc" ? (
          <ArrowUpAZ size={13} />
        ) : (
          <ArrowDownAZ size={13} />
        )
      ) : (
        <ChevronDown size={13} />
      )}
    </button>
  );
}

function TableCard({
  rows,
  loading,
  sortKey,
  sortDirection,
  onSort,
}: {
  rows: StratigraphyEntry[];
  loading: boolean;
  sortKey: keyof StratigraphyEntry;
  sortDirection: "asc" | "desc";
  onSort: (key: keyof StratigraphyEntry) => void;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows.length, sortKey, sortDirection]);
  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const maxPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  return (
    <section className="table-card panel">
      <div className="panel-heading">
        <div>
          <div className="section-kicker">
            <BarChart3 size={13} /> Primary record
          </div>
          <h2>Series index</h2>
        </div>
        <span className="row-indicator">
          {rows.length
            ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, rows.length)}`
            : "0"}{" "}
          <em>of</em> {rows.length}
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <SortButton
                  label="DAY"
                  active={sortKey === "day"}
                  direction={sortDirection}
                  onClick={() => onSort("day")}
                />
              </th>
              <th>
                <SortButton
                  label="TITLE"
                  active={sortKey === "title"}
                  direction={sortDirection}
                  onClick={() => onSort("title")}
                />
              </th>
              <th>
                <SortButton
                  label="VIDEO ID"
                  active={sortKey === "video_id"}
                  direction={sortDirection}
                  onClick={() => onSort("video_id")}
                />
              </th>
              <th>SUMMARY STATUS</th>
              <th className="action-head">SOURCE</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 6 }).map((_, index) => (
                <tr key={`skeleton-${index}`} className="skeleton-row">
                  <td>
                    <i />
                  </td>
                  <td>
                    <i />
                  </td>
                  <td>
                    <i />
                  </td>
                  <td>
                    <i />
                  </td>
                  <td>
                    <i />
                  </td>
                </tr>
              ))
            ) : pageRows.length ? (
              pageRows.map((entry) => (
                <tr key={`${entry.day}-${entry.video_id}`}>
                  <td>
                    <span className="day-cell">
                      {String(entry.day).padStart(3, "0")}
                    </span>
                  </td>
                  <td>
                    <div className="title-cell">
                      <strong>{entry.title}</strong>
                      <span>
                        {getSignals(entry.title)
                          .slice(0, 2)
                          .map((signal) => (
                            <Signal key={signal}>{signal}</Signal>
                          ))}
                      </span>
                    </div>
                  </td>
                  <td>
                    <code>{entry.video_id}</code>
                  </td>
                  <td>
                    <span className="status-badge">
                      <Check size={12} /> Indexed
                    </span>
                  </td>
                  <td className="action-cell">
                    <a
                      href={`https://www.youtube.com/watch?v=${encodeURIComponent(entry.video_id)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="watch-link"
                    >
                      Open <ExternalLink size={13} />
                    </a>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  <div className="table-empty">
                    <div className="empty-glyph">
                      <Search size={20} />
                    </div>
                    <strong>No strata match this scope</strong>
                    <span>
                      Try widening the day range or clearing the search.
                    </span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <span>
          Page <strong>{rows.length ? page + 1 : 0}</strong> of{" "}
          {rows.length ? maxPage + 1 : 0}
        </span>
        <div>
          <button
            onClick={() => setPage((value) => Math.max(0, value - 1))}
            disabled={page === 0}
          >
            <ChevronLeft size={15} /> Previous
          </button>
          <button
            onClick={() => setPage((value) => Math.min(maxPage, value + 1))}
            disabled={page >= maxPage}
          >
            Next <ChevronRight size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{label}</strong>
      {payload.map((item, index) => (
        <div key={`${item.name}-${index}`}>
          <span style={{ background: item.color }} />
          {item.name}
          <b>{item.value}</b>
        </div>
      ))}
    </div>
  );
}

function Insights({ rows }: { rows: StratigraphyEntry[] }) {
  const progression = useMemo(() => {
    if (!rows.length) return [];
    const sorted = [...rows].sort((a, b) => a.day - b.day);
    const bucketSize = rows.length > 100 ? 14 : 7;
    const buckets: Array<{
      day: string;
      "10M framing": number;
      "price thesis": number;
      "cycle marker": number;
    }> = [];
    for (let index = 0; index < sorted.length; index += bucketSize) {
      const bucket = sorted.slice(index, index + bucketSize);
      const counts = { "10M framing": 0, "price thesis": 0, "cycle marker": 0 };
      bucket.forEach((entry) =>
        getSignals(entry.title).forEach((signal) => {
          if (signal in counts) counts[signal as keyof typeof counts] += 1;
        }),
      );
      buckets.push({
        day: `${bucket[0].day}–${bucket[bucket.length - 1].day}`,
        ...counts,
      });
    }
    return buckets;
  }, [rows]);
  const signalBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    rows.forEach((entry) =>
      getSignals(entry.title).forEach((signal) =>
        counts.set(signal, (counts.get(signal) || 0) + 1),
      ),
    );
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }));
  }, [rows]);
  return (
    <div className="insights-grid">
      <section className="panel chart-panel">
        <div className="panel-heading">
          <div>
            <div className="section-kicker">
              <BarChart3 size={13} /> Longitudinal signal
            </div>
            <h2>How the framing moves</h2>
          </div>
          <span className="chart-note">per 7-day layer</span>
        </div>
        <div className="chart-wrap">
          {progression.length ? (
            <ResponsiveContainer width="100%" height={238}>
              <AreaChart
                data={progression}
                margin={{ top: 8, right: 12, left: -18, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="goldArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#d99a16" stopOpacity={0.28} />
                    <stop
                      offset="100%"
                      stopColor="#d99a16"
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: "var(--chart-tick)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: "var(--chart-tick)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="10M framing"
                  stroke="#d99a16"
                  fill="url(#goldArea)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="price thesis"
                  stroke="#b9533c"
                  fill="transparent"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="cycle marker"
                  stroke="#3f766a"
                  fill="transparent"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="chart-empty">No chartable strata in view</div>
          )}
        </div>
        <div className="chart-legend">
          <span>
            <i className="dot gold" />
            10M framing
          </span>
          <span>
            <i className="dot rust" />
            price thesis
          </span>
          <span>
            <i className="dot teal" />
            cycle marker
          </span>
        </div>
      </section>
      <section className="panel chart-panel breakdown-panel">
        <div className="panel-heading">
          <div>
            <div className="section-kicker">
              <Layers3 size={13} /> Vocabulary map
            </div>
            <h2>Title-signal breakdown</h2>
          </div>
          <span className="chart-note">top signals</span>
        </div>
        <div className="breakdown-content">
          {signalBreakdown.length ? (
            <>
              <ResponsiveContainer width="48%" height={190}>
                <PieChart>
                  <Pie
                    data={signalBreakdown}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={52}
                    outerRadius={78}
                    paddingAngle={3}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {signalBreakdown.map((entry, index) => (
                      <Cell key={entry.name} fill={CHART_COLORS[index]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="breakdown-list">
                {signalBreakdown.map((entry, index) => (
                  <div className="breakdown-row" key={entry.name}>
                    <span>
                      <i
                        className="dot"
                        style={{ background: CHART_COLORS[index] }}
                      />
                      {entry.name}
                    </span>
                    <strong>
                      {entry.value}
                      <small>
                        {rows.length
                          ? ` / ${Math.round((entry.value / rows.length) * 100)}%`
                          : ""}
                      </small>
                    </strong>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="chart-empty">No signals in view</div>
          )}
        </div>
      </section>
    </div>
  );
}

function Home() {
  const query = useQuery({
    queryKey: ["stratigraphy", "complete-primary-dataset"],
    queryFn: loadCompleteDataset,
    staleTime: Infinity,
  });
  const [search, setSearch] = useState("");
  const [minDay, setMinDay] = useState("");
  const [maxDay, setMaxDay] = useState("");
  const [sortKey, setSortKey] = useState<keyof StratigraphyEntry>("day");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const allRows = query.data || [];
  const loading = query.isLoading || query.isFetching;
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return allRows.filter((entry) => {
      const searchable =
        `${entry.title} ${entry.video_id} ${entry.transcript_summary}`.toLowerCase();
      return (
        (!needle || searchable.includes(needle)) &&
        (!minDay || entry.day >= Number(minDay)) &&
        (!maxDay || entry.day <= Number(maxDay))
      );
    });
  }, [allRows, search, minDay, maxDay]);
  const sortedRows = useMemo(
    () =>
      [...filteredRows].sort((a, b) => {
        const left = a[sortKey];
        const right = b[sortKey];
        const comparison =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        return sortDirection === "asc" ? comparison : -comparison;
      }),
    [filteredRows, sortKey, sortDirection],
  );
  const stats = useMemo(() => {
    const days = filteredRows.map((entry) => entry.day);
    const signals = filteredRows.filter((entry) =>
      getSignals(entry.title).includes("10M framing"),
    ).length;
    return {
      first: Math.min(...days),
      last: Math.max(...days),
      signals,
      density: filteredRows.length
        ? Math.round((signals / filteredRows.length) * 100)
        : 0,
    };
  }, [filteredRows]);
  const lastRefreshed = query.dataUpdatedAt
    ? new Date(query.dataUpdatedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const reset = () => {
    setSearch("");
    setMinDay("");
    setMaxDay("");
  };
  const onSort = (key: keyof StratigraphyEntry) => {
    if (sortKey === key)
      setSortDirection((value) => (value === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };
  return (
    <div className="app-shell">
      <div className="grain" />
      <div className="shell-inner">
        <Header
          onRefresh={() => query.refetch()}
          onExport={() => downloadCsv(filteredRows)}
          refreshing={query.isFetching}
          lastRefreshed={lastRefreshed}
          rowCount={filteredRows.length}
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
          <>
            <div className="stats-row">
              <StatCard
                label="VISIBLE ENTRIES"
                value={loading ? "—" : filteredRows.length.toLocaleString()}
                detail={
                  loading
                    ? "Reading dataset"
                    : `${allRows.length.toLocaleString()} total in source`
                }
              />
              <StatCard
                label="STRATA SPAN"
                value={
                  loading || !filteredRows.length
                    ? "—"
                    : `${formatDay(stats.first)}–${formatDay(stats.last)}`
                }
                detail="Day range in current view"
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
            <div className="workspace-grid">
              <FilterRail
                search={search}
                setSearch={setSearch}
                minDay={minDay}
                setMinDay={setMinDay}
                maxDay={maxDay}
                setMaxDay={setMaxDay}
                reset={reset}
                total={allRows.length}
                filtered={filteredRows.length}
              />
              <main className="content-column">
                <TableCard
                  rows={sortedRows}
                  loading={loading}
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={onSort}
                />
                <Insights rows={filteredRows} />
              </main>
            </div>
          </>
        )}
        <footer className="footer-note">
          <span>
            <Play size={12} fill="currentColor" /> SOURCE LINKS OPEN IN A NEW
            TAB
          </span>
          <span>
            ARCHITECTED BY CHARLES R. STROGISH | POWERED BY L402 MICROPAYMENTS,
            GROTH16 ZK-SNARK PROOFS &amp; NOSTR P2P MESH CONSENSUS.
          </span>
        </footer>
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
        <Route path="/simulator" component={SimulatorPage} />
        <Route component={NotFound} />
      </Switch>
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
