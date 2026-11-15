import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronRight, Copy, ExternalLink, Layers, Lock,
  Pause, Play, RefreshCw, Search, Settings2, ShieldAlert, Terminal, X, Zap,
} from "lucide-react";
import { Drawer, Modal, Skeleton, ToastProvider, useToast } from "@/components/primitives";
import { buildFixtures, makeRecord, makeRng, SIM_LIMIT, type FlightRecord, type RecordStatus } from "@/lib/fixtures";
import { useConnection, type ConnStatus, type ConnectionState } from "@/hooks/use-connection";

const STRIPE_URL = "https://buy.stripe.com/8x228q0IE9A40uHehz7ss00";

const STATUS_META: Record<ConnStatus, { label: string; tone: string; dot: string }> = {
  missing: { label: "API disconnected", tone: "text-[hsl(4_70%_62%)]", dot: "bg-[hsl(4_70%_55%)]" },
  unverified: { label: "Key present, unverified", tone: "text-[hsl(45_80%_62%)]", dot: "bg-[hsl(45_80%_55%)]" },
  verified: { label: "API verified", tone: "text-[hsl(176_45%_55%)]", dot: "bg-[hsl(176_45%_50%)]" },
  invalid: { label: "Key rejected", tone: "text-[hsl(4_70%_62%)]", dot: "bg-[hsl(4_70%_55%)]" },
  unavailable: { label: "Upstream unavailable", tone: "text-[hsl(45_80%_62%)]", dot: "bg-[hsl(45_80%_55%)]" },
};

const REC_STATUS: Record<RecordStatus, string> = {
  settled: "text-[hsl(176_45%_58%)] border-[hsl(176_40%_40%/.5)] bg-[hsl(176_40%_40%/.1)]",
  pending: "text-[hsl(45_80%_64%)] border-[hsl(45_70%_50%/.45)] bg-[hsl(45_70%_50%/.08)]",
  rejected: "text-[hsl(4_70%_64%)] border-[hsl(4_70%_52%/.45)] bg-[hsl(4_70%_52%/.08)]",
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toISOString().slice(11, 19) + "Z";
}
function short(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

function DemoTag({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-sm border border-dashed border-primary/60 px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-primary ${className}`}>
      Demo
    </span>
  );
}

function Panel({ title, kicker, right, children, className = "", delay = 0 }: {
  title: string; kicker?: string; right?: React.ReactNode; children: React.ReactNode; className?: string; delay?: number;
}) {
  return (
    <section className={`rise relative rounded-lg border border-card-border bg-card/80 backdrop-blur-sm ${className}`} style={{ animationDelay: `${delay}ms` }}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          {kicker && <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{kicker}</div>}
          <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function IconBtn({ onClick, label, children, testId, disabled, active }: {
  onClick: () => void; label: string; children: React.ReactNode; testId: string; disabled?: boolean; active?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} data-testid={testId} aria-label={label}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] uppercase tracking-wider transition-[transform,background-color,border-color] duration-150 active:scale-[0.97] disabled:opacity-50 ${active ? "border-primary/60 bg-primary/10 text-primary" : "border-border bg-secondary/60 text-foreground/85 hover:border-primary/40 hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

export default function Dashboard() {
  return <ToastProvider><DashboardInner /></ToastProvider>;
}

function DashboardInner() {
  const { toast } = useToast();
  const statusQ = useConnection();

  const fixtures = useMemo(() => buildFixtures(36), []);
  const [records, setRecords] = useState<FlightRecord[]>(fixtures);
  const [paused, setPaused] = useState(false);
  const [simCount, setSimCount] = useState(0);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<RecordStatus | "all">("all");
  const [frameworkFilter, setFrameworkFilter] = useState("all");
  const [selected, setSelected] = useState<FlightRecord | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [intervalMs, setIntervalMs] = useState(2600);
  const [compact, setCompact] = useState(false);

  const rngRef = useRef(makeRng(4402));
  const seqRef = useRef(1037);

  // Bounded sample simulation; cleaned up on pause, unmount or limit.
  useEffect(() => {
    if (paused || simCount >= SIM_LIMIT) return;
    const t = window.setInterval(() => {
      const rec = makeRecord(rngRef.current, seqRef.current++, new Date());
      setRecords((prev) => [rec, ...prev].slice(0, 80));
      setFreshId(rec.id);
      setSimCount((c) => c + 1);
    }, intervalMs);
    return () => window.clearInterval(t);
  }, [paused, simCount, intervalMs]);

  const frameworks = useMemo(() => Array.from(new Set(fixtures.map((r) => r.framework))).sort(), [fixtures]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (frameworkFilter === "all" || r.framework === frameworkFilter) &&
      (!q || [r.id, r.agent, r.action, r.proofHash, r.framework].some((v) => v.toLowerCase().includes(q))),
    );
  }, [records, query, statusFilter, frameworkFilter]);

  const metrics = useMemo(() => {
    const settled = records.filter((r) => r.status === "settled");
    const sats = settled.reduce((s, r) => s + r.sats, 0);
    const pending = records.filter((r) => r.status === "pending").length;
    const rejected = records.filter((r) => r.status === "rejected").length;
    const agents = new Set(records.map((r) => r.agent)).size;
    return { proofs: records.length, settled: settled.length, sats, pending, rejected, agents, avg: settled.length ? sats / settled.length : 0 };
  }, [records]);

  const conn = statusQ.data;
  const simExhausted = simCount >= SIM_LIMIT;

  const refresh = () => {
    statusQ.verify().then(
      (d) => toast({ title: STATUS_META[d.status]?.label ?? "Status refreshed", description: d.message }),
      (e) => toast({ title: "Verification request failed", description: (e as Error).message, variant: "destructive" }),
    );
  };

  const resetSim = () => {
    rngRef.current = makeRng(4402);
    seqRef.current = 1037;
    setRecords(fixtures);
    setSimCount(0);
    setPaused(false);
    toast({ title: "Sample feed reset", description: "Deterministic fixtures restored." });
  };

  return (
    <div className="strata-bg grain min-h-[100dvh] text-foreground">
      {/* Demo banner */}
      <div className="border-b border-primary/25 bg-primary/[0.07]">
        <div className="mx-auto flex max-w-[1440px] items-center gap-2 px-4 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-primary/90 sm:px-6">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Sample data preview. No real proofs, transactions, or compliance guarantees.</span>
        </div>
      </div>

      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-md border border-primary/40 bg-gradient-to-b from-primary/25 to-transparent">
              <Layers className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="leading-tight">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Bitcoin Stratigraphy</div>
              <h1 className="text-[17px] font-extrabold tracking-tight">Article 12 Flight Recorder</h1>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ConnPill conn={conn} loading={statusQ.isLoading} error={!!statusQ.error} />
            <IconBtn onClick={() => setConfigOpen(true)} label="Open configuration" testId="button-open-config">
              <Settings2 className="h-3.5 w-3.5" /><span className="hidden sm:inline">Configure</span>
            </IconBtn>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] space-y-5 px-4 py-6 sm:px-6">
        {/* Metrics strata */}
        {conn?.status !== "verified" && (
          <section aria-label="Production access locked" className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/[0.07] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Lock className="h-5 w-5 shrink-0 text-primary" />
              <div><div className="font-semibold">Production access locked</div><p className="text-xs text-muted-foreground">Connect your Enterprise API Block. Explore sample records below.</p></div>
            </div>
            <a href={STRIPE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:brightness-110">
              Procure $500 API Block <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </section>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-[1.4fr_1.4fr_1fr_1fr]">
          <Metric delay={0} kicker="Zero-Knowledge Proofs Generated" value={metrics.proofs.toLocaleString()} sub={`${metrics.agents} sample agents in session`} accent />
          <Metric delay={60} kicker="L402 Micropayments Settled" value={metrics.settled.toLocaleString()} sub={`${metrics.sats.toLocaleString()} sats · avg ${metrics.avg.toFixed(1)}`} />
          <Metric delay={120} kicker="Pending invoices" value={String(metrics.pending)} sub="awaiting preimage" />
          <Metric delay={180} kicker="Rejected proofs" value={String(metrics.rejected)} sub="failed verifier check" />
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* Feed */}
          <Panel
            delay={100}
            kicker="Sample stream"
            title="Zero-Knowledge Proofs Generated"
            right={
              <div className="flex items-center gap-2">
                <span className="hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground sm:flex">
                  <span className={`h-1.5 w-1.5 rounded-full ${paused || simExhausted ? "bg-muted-foreground" : "pulse-dot bg-primary"}`} />
                  {simExhausted ? "Sim limit reached" : paused ? "Paused" : "Simulating"} · {simCount}/{SIM_LIMIT}
                </span>
                {simExhausted ? (
                  <IconBtn onClick={resetSim} label="Reset sample feed" testId="button-reset-feed"><RefreshCw className="h-3.5 w-3.5" />Reset</IconBtn>
                ) : (
                  <IconBtn onClick={() => setPaused((p) => !p)} label={paused ? "Resume sample feed" : "Pause sample feed"} testId="button-toggle-feed" active={paused}>
                    {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{paused ? "Resume" : "Pause"}
                  </IconBtn>
                )}
              </div>
            }
          >
            {/* Filters */}
            <div className="flex flex-col gap-2 border-b border-border px-4 py-3 md:flex-row md:items-center">
              <label className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="input-search"
                  placeholder="Search id, agent, action, proof hash"
                  className="h-9 w-full rounded-md border border-input bg-background/60 pl-8 pr-8 font-mono text-[12px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60"
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")} data-testid="button-clear-search" aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
              <div className="flex gap-1 overflow-x-auto">
                {(["all", "settled", "pending", "rejected"] as const).map((s) => (
                  <button key={s} type="button" onClick={() => setStatusFilter(s)} data-testid={`filter-status-${s}`}
                    className={`h-9 shrink-0 rounded-md border px-3 font-mono text-[11px] uppercase tracking-wider transition-colors ${statusFilter === s ? "border-primary/60 bg-primary/12 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                    {s}
                  </button>
                ))}
              </div>
              <select value={frameworkFilter} onChange={(e) => setFrameworkFilter(e.target.value)} data-testid="select-framework"
                className="h-9 rounded-md border border-input bg-background/60 px-2 font-mono text-[11px] uppercase tracking-wider outline-none focus:border-primary/60">
                <option value="all">All frameworks</option>
                {frameworks.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>

            {/* Table head */}
            <div className="hidden grid-cols-[96px_110px_minmax(0,1.3fr)_minmax(0,1fr)_86px_64px_20px] gap-3 border-b border-border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground md:grid">
              <span>Time</span><span>Agent</span><span>Action</span><span>Proof hash</span><span>Status</span><span className="text-right">Sats</span><span />
            </div>

            <div className="max-h-[560px] overflow-y-auto" data-testid="list-records">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-full border border-dashed border-border"><Search className="h-5 w-5 text-muted-foreground" /></div>
                  <div className="font-semibold">No sample records match</div>
                  <p className="max-w-xs text-sm text-muted-foreground">Nothing in this stratum. Widen the filters or clear the search to see the full sample feed.</p>
                  <button type="button" data-testid="button-reset-filters" onClick={() => { setQuery(""); setStatusFilter("all"); setFrameworkFilter("all"); }}
                    className="font-mono text-[11px] uppercase tracking-wider text-primary hover:underline">Reset filters</button>
                </div>
              ) : (
                filtered.map((r) => (
                  <button key={r.id} type="button" onClick={() => setSelected(r)} data-testid={`row-record-${r.id}`}
                    className={`group grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-b border-border/60 px-4 text-left transition-colors hover:bg-primary/[0.05] md:grid-cols-[96px_110px_minmax(0,1.3fr)_minmax(0,1fr)_86px_64px_20px] md:items-center ${compact ? "py-1.5" : "py-2.5"} ${r.id === freshId ? "row-in" : ""}`}>
                    <span className="font-mono text-[11px] text-muted-foreground md:order-none">{fmtTime(r.timestamp)}</span>
                    <span className="justify-self-end md:hidden"><StatusChip s={r.status} /></span>
                    <span className="truncate font-mono text-[12px] text-foreground/90">{r.agent}</span>
                    <span className="col-span-2 truncate text-[13px] md:col-span-1"><span className="text-foreground">{r.action}</span> <span className="text-muted-foreground">· {r.framework}</span></span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground/80">{short(r.proofHash)}</span>
                    <span className="hidden md:block"><StatusChip s={r.status} /></span>
                    <span className="hidden text-right font-mono text-[12px] tabular-nums md:block">{r.sats}</span>
                    <ChevronRight className="hidden h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary md:block" />
                  </button>
                ))
              )}
            </div>
            <footer className="flex items-center justify-between px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <span data-testid="text-record-count">{filtered.length} of {records.length} sample records</span>
              <DemoTag />
            </footer>
          </Panel>

          {/* Right rail */}
          <div className="space-y-5">
            <ApiStatusPanel conn={conn} loading={statusQ.isLoading} error={statusQ.error}
              refreshing={statusQ.isVerifying} onRefresh={refresh} onRetry={() => void statusQ.refetch()} />
            <ProcurePanel conn={conn} />
          </div>
        </div>
      </main>

      <footer className="mx-auto max-w-[1440px] px-4 pb-8 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70 sm:px-6">
        Local-first · open source · every record on this screen is demonstration data
      </footer>

      <RecordSheet record={selected} onClose={() => setSelected(null)} />

      <Modal open={configOpen} onClose={() => setConfigOpen(false)} title="Recorder configuration"
        description="Preview controls apply to the sample feed only. The API credential lives on the server and is never entered here.">
          <div className="space-y-5">
            <div>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Sample cadence</div>
              <div className="grid grid-cols-3 gap-1.5">
                {[["Slow", 5000], ["Normal", 2600], ["Brisk", 1200]].map(([l, v]) => (
                  <button key={l} type="button" data-testid={`button-cadence-${String(l).toLowerCase()}`} onClick={() => setIntervalMs(v as number)}
                    className={`h-9 rounded-md border font-mono text-[11px] uppercase tracking-wider transition-colors ${intervalMs === v ? "border-primary/60 bg-primary/12 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
                    {l} · {(Number(v) / 1000).toFixed(1)}s
                  </button>
                ))}
              </div>
            </div>
            <label className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2.5">
              <span className="text-sm">Compact row density</span>
              <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} data-testid="toggle-compact" className="h-4 w-4 accent-[hsl(33_92%_54%)]" />
            </label>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
              <span className="text-sm">Restore deterministic fixtures</span>
              <IconBtn onClick={resetSim} label="Reset sample feed" testId="button-config-reset"><RefreshCw className="h-3.5 w-3.5" />Reset</IconBtn>
            </div>
            <EnvInstructions />
          </div>
      </Modal>
    </div>
  );
}

function Metric({ kicker, value, sub, accent, delay }: { kicker: string; value: string; sub: string; accent?: boolean; delay: number }) {
  return (
    <div className="rise group relative overflow-hidden rounded-lg border border-card-border bg-card/80 p-4 transition-colors hover:border-primary/35" style={{ animationDelay: `${delay}ms` }}>
      <div className={`absolute inset-x-0 top-0 h-[2px] ${accent ? "bg-primary" : "bg-[hsl(176_40%_40%)]"} opacity-70`} />
      <div className="flex items-start justify-between gap-2">
        <div className="font-mono text-[10px] uppercase leading-snug tracking-[0.14em] text-muted-foreground">{kicker}</div>
        <DemoTag />
      </div>
      <div className="mt-3 font-mono text-3xl font-bold tabular-nums tracking-tight sm:text-4xl" data-testid={`text-metric-${kicker.toLowerCase().replace(/\W+/g, "-")}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function StatusChip({ s }: { s: RecordStatus }) {
  return <span className={`inline-flex rounded-sm border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider ${REC_STATUS[s]}`}>{s}</span>;
}

function ConnPill({ conn, loading, error }: { conn?: ConnectionState; loading: boolean; error: boolean }) {
  if (loading) return <Skeleton className="h-8 w-36" />;
  const meta = error ? { label: "Status unreachable", tone: "text-[hsl(4_70%_62%)]", dot: "bg-[hsl(4_70%_55%)]" } : conn ? STATUS_META[conn.status] : STATUS_META.unavailable;
  return (
    <span data-testid="status-connection-pill" className={`inline-flex h-8 items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 font-mono text-[11px] uppercase tracking-wider ${meta.tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} /><span className="hidden sm:inline">{meta.label}</span>
    </span>
  );
}

function ApiStatusPanel({ conn, loading, error, refreshing, onRefresh, onRetry }: {
  conn?: ConnectionState; loading: boolean; error: Error | null; refreshing: boolean; onRefresh: () => void; onRetry: () => void;
}) {
  return (
    <Panel delay={160} kicker="Local API" title="API Status"
      right={<IconBtn onClick={onRefresh} disabled={refreshing || loading} label="Refresh connection" testId="button-refresh-connection">
        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />{refreshing ? "Checking" : "Refresh"}
      </IconBtn>}>
      <div className="space-y-3 p-4">
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3" data-testid="status-api-error">
            <div className="flex items-center gap-2 text-sm font-semibold text-[hsl(4_70%_68%)]"><AlertTriangle className="h-4 w-4" />Could not reach local status endpoint</div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{error.message}</p>
            <button type="button" onClick={onRetry} data-testid="button-retry-status" className="mt-2 font-mono text-[11px] uppercase tracking-wider text-primary hover:underline">Retry</button>
          </div>
        ) : conn ? (
          <>
            <div className="flex items-center gap-2" data-testid="status-api">
              {conn.status === "verified" ? <CheckCircle2 className="h-5 w-5 text-[hsl(176_45%_55%)]" /> : <Activity className={`h-5 w-5 ${STATUS_META[conn.status].tone}`} />}
              <span className={`text-lg font-semibold tracking-tight ${STATUS_META[conn.status].tone}`}>{STATUS_META[conn.status].label}</span>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="text-api-message">{conn.message}</p>
            <dl className="grid grid-cols-2 gap-2 font-mono text-[11px]">
              <div className="rounded border border-border px-2 py-1.5"><dt className="text-muted-foreground">Key configured</dt><dd>{conn.configured ? "yes (server)" : "no"}</dd></div>
              <div className="rounded border border-border px-2 py-1.5"><dt className="text-muted-foreground">Checked</dt><dd>{conn.checkedAt ? new Date(conn.checkedAt).toLocaleTimeString() : "never"}</dd></div>
            </dl>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80" data-testid="text-verify-scope">
              Verified = the issuer confirmed your existing funded scanner macaroon via its idempotent mint-macaroon entitlement route. Not a universal API key, live telemetry, or remaining-credit check.
            </p>
            {conn.status === "verified" && (
              <p className="rounded-md border border-dashed border-primary/40 p-2 text-xs text-primary/90">Connection verified. The feed on this screen remains sample data and is labelled demo.</p>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function ProcurePanel({ conn }: { conn?: ConnectionState }) {
  const verified = conn?.status === "verified";
  return (
    <section className="rise relative overflow-hidden rounded-lg border border-primary/45 bg-gradient-to-b from-primary/[0.12] via-card/90 to-card/90" style={{ animationDelay: "220ms" }} data-testid="panel-procurement">
      <div className="pointer-events-none absolute inset-0 opacity-40" style={{ background: "repeating-linear-gradient(135deg, transparent 0 14px, hsl(33 92% 54% / .05) 14px 15px)" }} />
      <div className="relative space-y-4 p-5">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md border border-primary/50 bg-primary/15"><Lock className="h-4 w-4 text-primary" /></div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">Live functionality locked</div>
            <div className="font-semibold tracking-tight">{verified ? "Key verified on server" : "Enterprise API Block required"}</div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Production access requires a funded scanner macaroon installed server-side as the Bitcoin Stratigraphy API key. This Phase 1 viewer displays demo telemetry even after verification. Purchase is not verified from this browser.
        </p>
        <a href={STRIPE_URL} target="_blank" rel="noopener noreferrer" data-testid="link-procure"
          className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition-transform duration-150 hover:-translate-y-px active:translate-y-0">
          <Zap className="h-4 w-4" />Procure $500 Enterprise API Block<ExternalLink className="h-3.5 w-3.5 opacity-70" />
        </a>
        <EnvInstructions />
      </div>
    </section>
  );
}

function EnvInstructions() {
  const { toast } = useToast();
  const line = "BITCOIN_STRATIGRAPHY_API_KEY=<your key>";
  return (
    <div className="rounded-md border border-border bg-background/70 p-3">
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground"><Terminal className="h-3 w-3" />Server setup</div>
      <ol className="space-y-1.5 text-xs text-muted-foreground">
        <li>1. Add to the local <span className="font-mono text-foreground">.env</span> next to the server:</li>
        <li className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1.5 font-mono text-[11px] text-foreground">
          <span className="truncate">{line}</span>
          <button type="button" aria-label="Copy env line" data-testid="button-copy-env"
            onClick={() => navigator.clipboard?.writeText("BITCOIN_STRATIGRAPHY_API_KEY=").then(() => toast({ title: "Copied variable name" }), () => toast({ title: "Clipboard unavailable", variant: "destructive" }))}
            className="text-muted-foreground transition-colors hover:text-primary"><Copy className="h-3.5 w-3.5" /></button>
        </li>
        <li>2. Restart the local server.</li>
        <li>3. Press Refresh in API Status to verify.</li>
      </ol>
    </div>
  );
}

function RecordSheet({ record, onClose }: { record: FlightRecord | null; onClose: () => void }) {
  const { toast } = useToast();
  const copy = (v: string) => navigator.clipboard?.writeText(v).then(() => toast({ title: "Copied" }), () => toast({ title: "Clipboard unavailable", variant: "destructive" }));
  return (
    <Drawer open={!!record} onClose={onClose} label="Record detail">
        {record && (
          <>
            <div className="space-y-2 pr-6">
              <div className="flex items-center gap-2"><DemoTag /><StatusChip s={record.status} /></div>
              <h2 className="font-mono text-lg font-semibold tracking-tight" data-testid="text-detail-id">{record.id}</h2>
              <p className="text-sm text-muted-foreground">Sample record. Not a real zero-knowledge proof or Lightning settlement.</p>
            </div>
            <dl className="mt-6 divide-y divide-border rounded-md border border-border">
              {([["Agent", record.agent], ["Framework", record.framework], ["Action", record.action], ["Timestamp", record.timestamp], ["Sats", String(record.sats)]] as const).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[100px_1fr] gap-2 px-3 py-2.5 text-sm">
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{k}</dt>
                  <dd className="break-all font-mono text-[12px]">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 rounded-md border border-border p-3">
              <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Proof hash
                <button type="button" onClick={() => copy(record.proofHash)} data-testid="button-copy-hash" className="flex items-center gap-1 hover:text-primary"><Copy className="h-3 w-3" />Copy</button>
              </div>
              <div className="break-all font-mono text-[12px] leading-relaxed text-primary/90" data-testid="text-detail-hash">{record.proofHash}</div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">This sample hash is illustrative, not cryptographic evidence. No proof verification is performed by this preview.</p>
          </>
        )}
    </Drawer>
  );
}
