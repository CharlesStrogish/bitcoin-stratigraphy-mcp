import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ShieldAlert, Terminal } from "lucide-react";
import "./article12-sandbox.css";

export const ARTICLE12_SANDBOX_ID = "article12-sandbox";

const DEFAULT_LOG = JSON.stringify(
  { agent: "gpt-4", action: "execute_trade", timestamp: "2026-11-08" },
  null,
  2,
);

const WARNING =
  "NON-COMPLIANT: Log is mutable and unanchored. Lacks cryptographic timestamp. Fails EU AI Act Article 12 traceback mandates. Liability risk detected.";

const STEPS = [
  "[x] Generating SHA-256 Digest...",
  "[x] Constructing RFC 6962 Merkle Flight Record...",
  "[x] Anchoring to OpenTimestamps...",
  "[x] Zero-Knowledge Indemnity Receipt Forged.",
];

type Phase = "idle" | "auditing" | "flagged" | "securing" | "secured";

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Article12Sandbox() {
  const [log, setLog] = useState(DEFAULT_LOG);
  const [phase, setPhase] = useState<Phase>("idle");
  const [shown, setShown] = useState(0);
  const section = useRef<HTMLElement>(null);
  const timers = useRef<number[]>([]);
  const runId = useRef(0);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const schedule = (fn: () => void, ms: number) => {
    const id = runId.current;
    timers.current.push(
      window.setTimeout(() => {
        if (id === runId.current) fn();
      }, ms),
    );
  };

  const reset = useCallback(() => {
    runId.current += 1;
    clearTimers();
    setPhase("idle");
    setShown(0);
  }, [clearTimers]);

  useEffect(
    () => () => {
      runId.current += 1;
      clearTimers();
    },
    [clearTimers],
  );

  useEffect(() => {
    if (window.location.hash !== `#${ARTICLE12_SANDBOX_ID}`) return;
    // Initial fragment navigation can finish before React mounts this section.
    const frame = requestAnimationFrame(() => {
      section.current?.scrollIntoView({ block: "start", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const empty = log.trim().length === 0;
  const busy = phase === "auditing" || phase === "securing";

  const runAudit = () => {
    if (empty || busy) return;
    reset();
    setPhase("auditing");
    schedule(() => setPhase("flagged"), reduced() ? 0 : 650);
  };

  const secure = () => {
    if (phase !== "flagged") return;
    setPhase("securing");
    setShown(0);
    const step = reduced() ? 120 : 620;
    STEPS.forEach((_, i) => schedule(() => setShown(i + 1), step * (i + 1)));
    schedule(() => setPhase("secured"), step * (STEPS.length + 1));
  };

  const showWarning = phase === "flagged" || phase === "securing" || phase === "secured";
  const showProof = phase === "securing" || phase === "secured";

  return (
    <section
      ref={section}
      id={ARTICLE12_SANDBOX_ID}
      className="a12s"
      aria-labelledby="a12s-title"
      data-testid="section-article12-sandbox"
    >
      <div className="a12s-head">
        <div>
          <div className="section-kicker">
            <Terminal size={11} aria-hidden="true" /> Flight recorder / Art. 12 sandbox
          </div>
          <h2 id="a12s-title" data-testid="text-sandbox-title">
            Article 12 Vulnerability Scanner (Interactive Sandbox)
          </h2>
        </div>
        <span className="a12s-sim" data-testid="status-simulation-label">
          <i aria-hidden="true" /> Local simulation - no data leaves this page
        </span>
      </div>

      <div className="a12s-body">
        <div className="a12s-input">
          <label htmlFor="a12s-log" className="a12s-label">
            Paste Sample AI Execution Log (or use default)
          </label>
          <textarea
            id="a12s-log"
            className="a12s-textarea"
            value={log}
            spellCheck={false}
            rows={7}
            aria-describedby="a12s-hint"
            data-testid="input-execution-log"
            onChange={(e) => {
              setLog(e.target.value);
              if (phase !== "idle") reset();
            }}
          />
          <p
            id="a12s-hint"
            className={`a12s-hint${empty ? " is-error" : ""}`}
            data-testid="text-audit-hint"
          >
            {empty
              ? "Enter a log sample to enable the audit."
              : "Held in browser memory only. Editing resets the simulation."}
          </p>
          <div className="a12s-actions">
            <button
              type="button"
              className="a12s-btn a12s-btn-audit"
              onClick={runAudit}
              disabled={empty || busy}
              aria-describedby="a12s-hint"
              data-testid="button-run-audit"
            >
              <ShieldAlert size={14} aria-hidden="true" />
              {phase === "auditing" ? "Auditing..." : "Run Compliance Audit"}
            </button>
            {phase !== "idle" && (
              <button
                type="button"
                className="a12s-btn a12s-btn-ghost"
                onClick={reset}
                disabled={busy}
                data-testid="button-reset-sandbox"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        <div className="a12s-term" data-testid="panel-sandbox-terminal">
          <div className="a12s-term-bar">
            <span className="a12s-dots" aria-hidden="true">
              <b /><b /><b />
            </span>
            <span>art12-scan :: simulated</span>
            <span data-testid="status-sandbox-phase">{phase.toUpperCase()}</span>
          </div>
          <div className="a12s-term-out" aria-live="polite" aria-atomic="false">
            {phase === "idle" && (
              <p className="a12s-muted" data-testid="text-terminal-idle">
                $ awaiting log sample<span className="a12s-caret" aria-hidden="true" />
              </p>
            )}
            {phase === "auditing" && (
              <p className="a12s-muted" data-testid="status-auditing">
                $ scanning log for anchor, timestamp, traceback fields...
              </p>
            )}
            {showWarning && (
              <div className="a12s-warn" role="alert" data-testid="status-noncompliant">
                {WARNING}
              </div>
            )}
            {phase === "flagged" && (
              <button
                type="button"
                className="a12s-btn a12s-btn-secure"
                onClick={secure}
                data-testid="button-secure"
              >
                Secure via Bitcoin Stratigraphy <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
            {showProof && (
              <ol className="a12s-steps" data-testid="list-secure-steps">
                {STEPS.slice(0, shown).map((s, i) => (
                  <li key={s} data-testid={`text-secure-step-${i + 1}`}>{s}</li>
                ))}
                {phase === "securing" && shown < STEPS.length && (
                  <li className="a12s-pending" aria-hidden="true">
                    <span className="a12s-caret" />
                  </li>
                )}
              </ol>
            )}
            {phase === "secured" && (
              <>
                <p className="a12s-success" data-testid="text-simulation-success">
                  ✓ L402 ZK-Proof Generated. Simulation Complete.
                </p>
                <p className="a12s-note" data-testid="text-simulation-note">
                  Visual demonstration only. No digest, anchor, proof, or receipt was produced.
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <a
        className="a12s-cta"
        href="https://buy.stripe.com/8x228q0IE9A40uHehz7ss00"
        data-testid="link-sandbox-cta"
      >
        <span>Deploy to Production: Secure $500 Enterprise API Block</span>
        <ArrowRight size={16} aria-hidden="true" />
      </a>
    </section>
  );
}
