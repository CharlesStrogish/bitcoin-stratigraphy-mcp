import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Play, RotateCcw, Square } from "lucide-react";
import { TrustBadges } from "@/components/trust-badges";
import EnterpriseLicenseLink from "@/components/enterprise-license-link";
import WhitepaperLink from "@/components/whitepaper-link";
import { SyntheticBanner } from "@/simulator/components/SyntheticBanner";
import ComplianceGuideLink from "@/components/compliance-guide-link";
import { EscrowTerminal } from "@/simulator/components/EscrowTerminal";
import { CopyJsonButton } from "@/simulator/components/CopyJsonButton";
import { AgentGrid } from "@/simulator/components/AgentGrid";
import { TreeGraph } from "@/simulator/components/TreeGraph";
import { TraceBrowser } from "@/simulator/components/TraceBrowser";
import {
  ProofInspector,
  type InspectState,
} from "@/simulator/components/ProofInspector";
import {
  AGENT_COUNT,
  TRACE_COUNT,
  buildProofExport,
  runSwarm,
  sleep,
  simulateNotarize,
  SwarmSession,
  verifyDisclosedProof,
} from "@/simulator/engine/simulation";

type Phase = "idle" | "running" | "notarizing" | "done" | "cancelled" | "error";
type Notarized = Awaited<ReturnType<typeof simulateNotarize>>;
type Peak = { start: number; width: number; hash: string };

function useMeta() {
  useEffect(() => {
    const prevTitle = document.title;
    let tag = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const created = !tag;
    if (!tag) {
      tag = document.createElement("meta");
      tag.name = "description";
      document.head.appendChild(tag);
    }
    const prevDesc = tag.content;
    document.title =
      "Enterprise Swarm Control Room | Bitcoin Stratigraphy Simulator";
    tag.content =
      "Browser-only synthetic simulation: 50 agents, 1000 traces, a rolling RFC 6962 Merkle tree with real SHA-256, selective-disclosure inclusion proofs, and a simulated proof.notarize anchor. No payment, no Bitcoin.";
    return () => {
      document.title = prevTitle;
      if (created) tag!.remove();
      else tag!.content = prevDesc;
    };
  }, []);
}

export default function SimulatorPage() {
  useMeta();
  const sessionRef = useRef<SwarmSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [version, setVersion] = useState(0);
  const [batch, setBatch] = useState(0);
  const [published, setPublished] = useState(0);
  const [root, setRoot] = useState("");
  const [peaks, setPeaks] = useState<Peak[]>([]);
  const [counts, setCounts] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [inspect, setInspect] = useState<InspectState>({ status: "idle" });
  const [anchor, setAnchor] = useState<Notarized | null>(null);
  const anchorJson = anchor ? JSON.stringify(anchor, null, 2) : null;
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");

  const pushLog = (line: string) => setLog((l) => [...l.slice(-7), line]);
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const reset = useCallback(
    (next: Phase) => {
      cancel();
      sessionRef.current = null;
      setPhase(next);
      setVersion((v) => v + 1);
      setBatch(0);
      setPublished(0);
      setRoot("");
      setPeaks([]);
      setCounts([]);
      setSelected(null);
      setInspect({ status: "idle" });
      setAnchor(null);
      setLog([]);
      setError("");
    },
    [cancel],
  );

  const run = useCallback(async () => {
    reset("running");
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const session = new SwarmSession();
      sessionRef.current = session;
      setPhase("running");
      pushLog(`batch ${session.batchId} opened`);
      await runSwarm({
        session,
        signal: ctl.signal,
        onBatch: async (e) => {
          const n = e.size;
          const [r, p] = await Promise.all([
            session.rootHex(n),
            session.peaks(n),
          ]);
          if (ctl.signal.aborted) return;
          const c = new Array(AGENT_COUNT).fill(0);
          session.records.slice(0, n).forEach((rec) => {
            c[Number(rec.trace.agent_id.slice(6))]++;
          });
          setPublished(n);
          setRoot(r);
          setPeaks(p);
          setCounts(c);
          setBatch(e.batch);
          setVersion((v) => v + 1);
          pushLog(
            `batch ${e.batch}/${e.batches}: ${e.size} leaves, root ${r.slice(0, 12)}`,
          );
        },
      });
      if (ctl.signal.aborted) return;
      const finalSize = session.size;
      const finalRoot = await session.rootHex(finalSize);
      if (ctl.signal.aborted) return;
      setPhase("notarizing");
      pushLog("proof.notarize (simulated) with X-L402-Batch-Size: 100");
      await sleep(450, ctl.signal);
      const receipt = await simulateNotarize(
        session.batchId,
        finalSize,
        finalRoot,
      );
      if (ctl.signal.aborted) return;
      setAnchor(receipt);
      setPhase("done");
      pushLog("simulated receipt bound to root; nothing was sent");
    } catch (e) {
      if (ctl.signal.aborted || (e as Error).name === "AbortError") return;
      setError((e as Error).message);
      setPhase("error");
    }
  }, [reset]);

  // Build and verify the inclusion path for the selection against the current root.
  useEffect(() => {
    const session = sessionRef.current;
    if (
      selected === null ||
      !session ||
      selected >= published ||
      !session.records[selected]
    ) {
      setInspect({ status: "idle" });
      return;
    }
    let live = true;
    setInspect({ status: "working" });
    (async () => {
      try {
        const rec = session.records[selected];
        const { proof, rootHex: r } = await session.disclosure(
          selected,
          published,
        );
        const ok = await verifyDisclosedProof(rec.trace, proof, r);
        if (live)
          setInspect({ status: ok ? "valid" : "invalid", proof, root: r });
      } catch (e) {
        if (live)
          setInspect({ status: "error", message: (e as Error).message });
      }
    })();
    return () => {
      live = false;
    };
  }, [selected, published]);

  const record =
    selected !== null && selected < published
      ? (sessionRef.current?.records[selected] ?? null)
      : null;
  const download = () => {
    if (!record || !inspect.proof || !inspect.root) return;
    const body = buildProofExport(record, inspect.proof, inspect.root, anchor);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `swarm-proof-trace-${record.index}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const size = published;
  const busy = phase === "running" || phase === "notarizing";
  const pct = Math.round((size / TRACE_COUNT) * 100);

  return (
    <div className="app-shell sim-page">
      <div className="grain" />
      <div className="shell-inner">
        <header className="topbar">
          <div className="eyebrow">
            <span className="eyebrow-line" /> SIMULATOR / SA-AI SWARM EVIDENCE
          </div>
          <div className="header-main">
            <div>
              <h1>
                Enterprise Swarm <span>Control Room</span>
              </h1>
              <p className="subtitle">
                Fifty synthetic agents emit 1000 traces. Each is salted, hashed
                and streamed into a rolling RFC 6962 Merkle tree. Pick any
                thought and verify it against the root.
              </p>
              <TrustBadges />
            </div>
            <div className="header-actions">
              <EnterpriseLicenseLink />
              <WhitepaperLink />
              <Link href="/" className="control-button" data-testid="link-home">
                <ArrowLeft size={14} /> Dashboard
              </Link>
            </div>
          </div>
        </header>
        <SyntheticBanner />

        <div className="sim-controls">
          <button
            type="button"
            className="sim-run"
            onClick={run}
            disabled={busy}
            data-testid="button-run-simulation"
          >
            <Play size={15} aria-hidden="true" />{" "}
            {phase === "done" || phase === "cancelled"
              ? "Run again"
              : "Run Simulation"}
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => reset("cancelled")}
            disabled={!busy}
            data-testid="button-stop"
          >
            <Square size={13} aria-hidden="true" /> Stop
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => reset("idle")}
            disabled={phase === "idle"}
            data-testid="button-reset"
          >
            <RotateCcw size={13} aria-hidden="true" /> Reset
          </button>
          <div
            className="sim-progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Traces streamed"
          >
            <span style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <span
            className="sim-phase"
            role="status"
            aria-live="polite"
            data-testid="status-phase"
          >
            {
              {
                idle: "Ready",
                running: `Streaming batch ${batch}/20`,
                notarizing: "Simulating proof.notarize",
                done: "Complete",
                cancelled: "Cancelled",
                error: "Error",
              }[phase]
            }
          </span>
        </div>
        {phase === "error" && (
          <div className="sim-bad panel sim-pad" role="alert">
            Simulation failed: {error}{" "}
            <button type="button" className="control-button" onClick={run}>
              Retry
            </button>
          </div>
        )}

        <div className="stats-row">
          <div className="stat-card stat-gold">
            <div className="stat-label">AGENTS</div>
            <div className="stat-value">
              {counts.filter(Boolean).length}/{AGENT_COUNT}
            </div>
            <div className="stat-detail">emitting in rounds of 50</div>
          </div>
          <div className="stat-card stat-rust">
            <div className="stat-label">LEAVES</div>
            <div className="stat-value" data-testid="text-leaf-count">
              {size}
            </div>
            <div className="stat-detail">of {TRACE_COUNT} synthetic traces</div>
          </div>
          <div className="stat-card stat-teal">
            <div className="stat-label">SUBTREES</div>
            <div className="stat-value">{peaks.length}</div>
            <div className="stat-detail">unpadded, no duplicated leaf</div>
          </div>
          <div className="stat-card stat-slate">
            <div className="stat-label">ROOT</div>
            <div className="stat-value sim-rootval" data-testid="text-root">
              {root ? root.slice(0, 12) : "none"}
            </div>
            <div className="stat-detail">SHA-256, 0x00 leaf / 0x01 node</div>
          </div>
        </div>

        <div className="sim-grid">
          <div className="sim-col">
            <section className="panel sim-panel">
              <div className="panel-heading">
                <div>
                  <div className="section-kicker">Swarm</div>
                  <h2>Agents and hash graph</h2>
                </div>
              </div>
              <div className="sim-pad">
                <AgentGrid
                  counts={counts}
                  total={TRACE_COUNT}
                  running={phase === "running"}
                />
                <TreeGraph
                  peaks={peaks}
                  root={root}
                  size={size}
                  pathHashes={inspect.proof?.path ?? []}
                  selected={selected}
                  records={
                    sessionRef.current?.records.slice(0, published) ?? []
                  }
                  onSelect={setSelected}
                />
              </div>
            </section>
            <section className="panel sim-panel" aria-labelledby="sim-events-h">
              <div className="panel-heading">
                <div>
                  <div className="section-kicker">Event stream</div>
                  <h2 id="sim-events-h">Control log</h2>
                </div>
              </div>
              <ol className="sim-log" data-testid="list-log">
                {log.length ? (
                  log.map((l, i) => <li key={i}>{l}</li>)
                ) : (
                  <li>Waiting for a run.</li>
                )}
              </ol>
            </section>
          </div>
          <div className="sim-col">
            <TraceBrowser
              records={sessionRef.current?.records.slice(0, published) ?? []}
              version={version}
              selected={selected}
              onSelect={setSelected}
            />
            <ProofInspector
              record={record}
              state={inspect}
              onDownload={download}
            />
          </div>
        </div>

        <section
          className="panel sim-panel sim-final"
          aria-labelledby="sim-anchor-h"
          data-testid="panel-anchor"
        >
          <div className="panel-heading">
            <div>
              <div className="section-kicker">Final event</div>
              <h2 id="sim-anchor-h">proof.notarize (simulated)</h2>
            </div>
            <div className="sim-receipt-actions">
              <span className="sim-tag">SYNTHETIC</span>
              <CopyJsonButton text={anchorJson} testId="button-copy-receipt-json" />
            </div>
          </div>
          <div className="sim-verdicts">
            <div className="sim-card sim-card-real">
              <div className="section-kicker">Genuine</div>
              <h3>Membership</h3>
              <p data-testid="status-genuine">
                {inspect.status === "valid"
                  ? `Trace #${selected} verified with real SHA-256 against the ${size}-leaf root.`
                  : "Select a thought to verify membership."}
              </p>
            </div>
            <div className="sim-card sim-card-fake">
              <div className="section-kicker">Simulated</div>
              <h3>Anchor</h3>
              <p data-testid="status-anchor">
                {anchor
                  ? "Illustrative receipt bound to the root. No payment, no calendar submission, no Bitcoin confirmation."
                  : phase === "notarizing"
                    ? "Simulating..."
                    : "Appears when the run completes."}
              </p>
            </div>
          </div>
          {anchor ? (
            <pre className="sim-pre" tabIndex={0} data-testid="text-receipt">
              {anchorJson}
            </pre>
          ) : (
            <div className="sim-empty">
              No receipt yet. The anchor is a labeled illustration, never valid
              OpenTimestamps bytes.
            </div>
          )}
        </section>
        <ComplianceGuideLink />
        <EscrowTerminal />
      </div>
    </div>
  );
}
