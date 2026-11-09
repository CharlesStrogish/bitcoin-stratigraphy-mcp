import { type FormEvent, useEffect, useId, useState } from "react";
import { useAuditScanner } from "../lib/use-audit-scanner";
import InvoiceQr from "../components/invoice-qr";
import { AuditIntro } from "./audit-content";

function join(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const MIN_LENGTH = 20;
const MAX_LENGTH = 20000;

function useCountdown(expiresAt: number | null) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt || now === null) return null;
  const ms = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  const left = Math.max(0, Math.floor((ms - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

const STEPS = ["Submit", "Pay", "Report"] as const;

export default function AuditPage({ base = import.meta.env.BASE_URL }: { base?: string }) {
  const id = useId();
  const scan = useAuditScanner();
  const [localError, setLocalError] = useState("");
  const [copied, setCopied] = useState(false);
  const { phase, challenge, report } = scan;
  const locked = phase !== "idle" && !(phase === "error" && !challenge);
  const countdown = useCountdown(phase === "awaiting_payment" || phase === "checking" ? challenge?.expiresAt ?? null : null);

  const stepIndex = report ? 2 : challenge ? 1 : 0;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = scan.prompt.trim();
    if (text.length < MIN_LENGTH) {
      setLocalError(`Enter at least ${MIN_LENGTH} characters describing the prompt or agent log to review.`);
      return;
    }
    setLocalError("");
    await scan.run();
  }

  async function copyInvoice() {
    if (!challenge) return;
    try {
      await navigator.clipboard.writeText(challenge.invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const invalid = !!localError;

  return (
    <div className="fn-page fn-page-audit">
      <div className="fn-shell fn-shell-narrow">
        <AuditIntro />

        <ol className="fn-steps fn-rise" aria-label="Scan progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i < stepIndex ? "is-done" : i === stepIndex ? "is-current" : ""} aria-current={i === stepIndex ? "step" : undefined}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              {s}
            </li>
          ))}
        </ol>

        <form className="fn-kiosk fn-rise" onSubmit={onSubmit} noValidate aria-labelledby={`${id}-h`}>
          <h2 id={`${id}-h`} className="fn-sr">Compliance scan input</h2>
          <label htmlFor={`${id}-prompt`} className="fn-label">Prompt or agent log</label>
          <textarea
            id={`${id}-prompt`}
            className="fn-textarea"
            rows={9}
            maxLength={MAX_LENGTH}
            value={scan.prompt}
            readOnly={locked}
            aria-readonly={locked || undefined}
            onChange={(e) => {
              scan.setPrompt(e.target.value);
              if (localError) setLocalError("");
            }}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
            placeholder="Paste the system prompt, tool-call trace or decision log to review..."
            data-testid="input-scan-prompt"
          />
          <div className="fn-kiosk-foot">
            <span id={hintId} className="fn-hint">
              {locked
                ? "Locked to this scan. Start over to edit."
                : `${scan.prompt.length.toLocaleString("en-US")} / ${MAX_LENGTH.toLocaleString("en-US")} characters. Do not paste secrets.`}
            </span>
            {!locked ? (
              <button type="submit" className="fn-btn fn-btn-primary fn-btn-lg" data-testid="button-run-scan">
                Run Compliance Scan
              </button>
            ) : phase === "quoting" ? (
              <button type="button" className="fn-btn fn-btn-primary fn-btn-lg" disabled aria-busy="true">
                Preparing invoice<span className="fn-dots" aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className="fn-btn fn-btn-quiet" onClick={scan.reset} data-testid="button-reset-scan">
                {report ? "New scan" : "Start over"}
              </button>
            )}
          </div>
          {invalid && (
            <p id={errorId} className="fn-msg fn-msg-error" role="alert" data-testid="text-scan-error">
              {localError}
            </p>
          )}
          {phase === "error" && !challenge && (
            <p className="fn-msg fn-msg-error" role="alert" data-testid="text-scan-error-remote">
              {scan.error || "The scan could not start. Try again."}
            </p>
          )}
        </form>

        <div aria-live="polite">
          {challenge && !report && (
            <section className="fn-pay fn-rise" aria-labelledby={`${id}-pay`} data-testid="panel-payment">
              <div className="fn-pay-qr">
                {phase === "expired" ? (
                  <div className="fn-pay-void">Invoice expired</div>
                ) : (
                  <InvoiceQr invoice={challenge.invoice} />
                )}
              </div>
              <div className="fn-pay-body">
                <p className="fn-kicker">Lightning payment</p>
                <h2 id={`${id}-pay`} className="fn-amount" data-testid="text-amount">
                  {challenge.amountSats.toLocaleString("en-US")} <small>sats</small>
                </h2>
                {phase === "expired" ? (
                  <p className="fn-msg fn-msg-error" role="alert" data-testid="status-expired">
                    This invoice expired before payment was confirmed. Start over to request a new one.
                  </p>
                ) : (
                  <>
                    <p className="fn-status" role="status" data-testid="status-payment">
                      <span className="fn-pulse" aria-hidden="true" />
                      {phase === "checking" ? "Checking payment" : "Waiting for payment"}
                      {countdown && <span className="fn-hint"> / expires in {countdown}</span>}
                    </p>
                    <div className="fn-cta-row fn-cta-tight">
                      <a className="fn-btn fn-btn-primary" href={`lightning:${challenge.invoice}`} data-testid="link-wallet">
                        Open in wallet
                      </a>
                      <button type="button" className="fn-btn" onClick={copyInvoice} data-testid="button-copy-invoice">
                        {copied ? "Copied" : "Copy invoice"}
                      </button>
                      <button
                        type="button"
                        className="fn-btn fn-btn-quiet"
                        onClick={() => void scan.checkNow()}
                        disabled={phase === "checking"}
                        data-testid="button-check-payment"
                      >
                        I have paid, check now
                      </button>
                    </div>
                    {phase === "error" && (
                      <p className="fn-msg fn-msg-error" role="alert" data-testid="text-payment-error">
                        {scan.error || "Payment check failed. Try checking again."}
                      </p>
                    )}
                  </>
                )}
                <details className="fn-invoice">
                  <summary>Show invoice text</summary>
                  <code data-testid="text-invoice">{challenge.invoice}</code>
                </details>
              </div>
            </section>
          )}

          {report && (
            <section className="fn-report fn-rise" aria-labelledby={`${id}-rep`} data-testid="panel-report">
              <header className="fn-report-head">
                <div>
                  <p className="fn-kicker">Heuristic report / {report.schema}</p>
                  <h2 id={`${id}-rep`} className="fn-h2">Overall risk</h2>
                </div>
                <span className={`fn-risk fn-risk-${report.overall_risk_level.toLowerCase()}`} data-testid="text-overall-risk">
                  {report.overall_risk_level}
                </span>
              </header>
              {report.flagged_categories.length === 0 ? (
                <p className="fn-note" data-testid="text-no-flags">No heuristic categories were flagged in this input.</p>
              ) : (
                <ul className="fn-flags">
                  {report.flagged_categories.map((f) => (
                    <li key={f.category} data-testid={`flag-${f.category}`}>
                      <div><strong>{f.label}</strong><span className="fn-risk fn-risk-high">{f.risk_level}</span></div>
                      <p>{f.rationale}</p>
                    </li>
                  ))}
                </ul>
              )}
              <dl className="fn-facts">
                <div><dt>Compliance hash</dt><dd><code data-testid="text-compliance-hash">{report.compliance_hash}</code></dd></div>
                <div><dt>Prompt SHA-256</dt><dd><code data-testid="text-prompt-hash">{report.prompt_sha256}</code></dd></div>
                <div>
                  <dt>Receipt</dt>
                  <dd data-testid="text-receipt-type">
                    Simulated receipt (<code>{report.receipt_type}</code>). Not a zero-knowledge proof.
                  </dd>
                </div>
              </dl>
              <p className="fn-note" data-testid="text-limitations">{report.limitations}</p>
            </section>
          )}
        </div>

        <section className="fn-terms fn-rise" aria-label="Scope of review">
          <div>
            <h3>What a scan is</h3>
            <p>An automated keyword heuristic over your input, mapped to Article 12 record-keeping risk.</p>
          </div>
          <div>
            <h3>What it is not</h3>
            <p>Legal certification, a conformity assessment or a cryptographic proof. Review results with counsel.</p>
          </div>
        </section>

        <aside className="fn-switch fn-rise">
          <span>Building an agent integration?</span>
          <a href={join(base, "developers")} data-testid="link-to-developers">Go to Developers</a>
        </aside>
      </div>
    </div>
  );
}
