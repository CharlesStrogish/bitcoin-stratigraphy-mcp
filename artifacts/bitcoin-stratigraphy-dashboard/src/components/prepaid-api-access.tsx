import { useEffect, useId, useRef, useState } from "react";
import { usePrepaidCredits } from "../lib/use-prepaid-credits";
import InvoiceQr from "./invoice-qr";

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

function formatValidUntil(v: number) {
  const ms = v > 1e12 ? v : v * 1000;
  return new Date(ms).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type CopyState = "idle" | "copied" | "failed";

/** Client-only payment kiosk. Credentials stay in memory; never stored, logged or sent to analytics. */
export default function PrepaidApiAccess() {
  const id = useId();
  const p = usePrepaidCredits();
  const { phase, challenge, grant } = p;
  const [invoiceCopy, setInvoiceCopy] = useState<CopyState>("idle");
  const [tokenCopy, setTokenCopy] = useState<CopyState>("idle");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const successRef = useRef<HTMLHeadingElement>(null);

  const complete = phase === "complete" && !!grant;
  const pending = phase === "quoting" || phase === "awaiting_payment" || phase === "checking";
  const invoiceRetained = !!challenge && !complete && phase !== "cleared";
  const canMint = !pending && !invoiceRetained;
  const countdown = useCountdown(
    phase === "awaiting_payment" || phase === "checking" || phase === "error" ? challenge?.expiresAt ?? null : null,
  );

  useEffect(() => {
    if (complete) successRef.current?.focus();
    else { setTokenCopy("idle"); setConfirmDiscard(false); }
  }, [complete]);

  async function copy(text: string, set: (s: CopyState) => void) {
    try {
      if (!navigator.clipboard) throw new Error("unavailable");
      await navigator.clipboard.writeText(text);
      set("copied");
    } catch {
      set("failed");
    }
  }

  return (
    <div className="fn-prepaid" data-testid="panel-prepaid">
      {!complete && (
        <div className="fn-prepaid-mint">
          <button
            type="button"
            className="fn-btn fn-btn-primary fn-btn-lg"
            onClick={() => { setInvoiceCopy("idle"); void p.run(); }}
            disabled={!canMint}
            aria-busy={phase === "quoting" || undefined}
            data-testid="button-mint-credits"
          >
            {phase === "quoting" ? <>Preparing invoice<span className="fn-dots" aria-hidden="true" /></> : "Mint 100 API Credits (100,000 sats)"}
          </button>
          {phase === "cleared" && (
            <p className="fn-hint" role="status" data-testid="status-cleared">Macaroon discarded from this page. Mint again to buy a new grant.</p>
          )}
          {phase === "error" && !challenge && (
            <p className="fn-msg fn-msg-error" role="alert" data-testid="text-mint-error">
              {p.error || "The invoice could not be created. Try again."}
            </p>
          )}
        </div>
      )}

      <div aria-live="polite">
        {invoiceRetained && (
          <section className="fn-pay fn-prepaid-pay" aria-labelledby={`${id}-pay`} data-testid="panel-prepaid-payment">
            <div className="fn-pay-body">
              <p className="fn-kicker">Lightning payment / 100 scanner credits</p>
              <h3 id={`${id}-pay`} className="fn-amount" data-testid="text-prepaid-amount">
                {challenge.amountSats.toLocaleString("en-US")} <small>sats</small>
              </h3>
              {phase === "expired" ? (
                <>
                  <div className="fn-pay-void">Verification paused</div>
                  <p className="fn-msg fn-msg-error" role="alert" data-testid="status-prepaid-expired">
                    Automatic verification has paused. If you already paid, do not pay again; check the original payment or contact the operator with your invoice.
                  </p>
                  <div className="fn-pay-actions">
                    <button type="button" className="fn-btn fn-btn-primary" onClick={() => void p.checkNow()} data-testid="button-prepaid-recover">
                      Check original payment again
                    </button>
                    <button type="button" className="fn-btn" onClick={p.clear} data-testid="button-prepaid-dismiss">
                      Dismiss expired invoice
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="fn-status" role="status" data-testid="status-prepaid-payment">
                    <span className="fn-pulse" aria-hidden="true" />
                    {phase === "checking" ? "Checking payment" : phase === "error" ? "Payment check interrupted" : "Waiting for payment"}
                    {countdown && <span className="fn-hint"> / expires in {countdown}</span>}
                  </p>
                  <div className="fn-pay-qr">
                    <InvoiceQr invoice={challenge.invoice} />
                  </div>
                  <div className="fn-pay-actions">
                    <a className="fn-btn fn-btn-primary" href={`lightning:${challenge.invoice}`} data-testid="link-prepaid-wallet">
                      Open in wallet
                    </a>
                    <button type="button" className="fn-btn" onClick={() => void copy(challenge.invoice, setInvoiceCopy)} data-testid="button-prepaid-copy-invoice">
                      {invoiceCopy === "copied" ? "Invoice copied" : "Copy invoice"}
                    </button>
                    <button
                      type="button"
                      className="fn-btn fn-btn-quiet"
                      onClick={() => void p.checkNow()}
                      disabled={phase === "checking"}
                      data-testid="button-prepaid-check"
                    >
                      {phase === "error" ? "Check original payment again" : "I have paid, check now"}
                    </button>
                  </div>
                  {invoiceCopy === "failed" && (
                    <p className="fn-msg fn-msg-error" role="alert">Clipboard unavailable. Use "Show invoice text" and copy it manually.</p>
                  )}
                  {phase === "error" && (
                    <p className="fn-msg fn-msg-error" role="alert" data-testid="text-prepaid-payment-error">
                      {p.error || "Payment check failed."} Do not pay a second invoice; check the original payment again.
                    </p>
                  )}
                  <p className="fn-hint">Checking automatically in the background. You can keep this tab open.</p>
                </>
              )}
              <details className="fn-invoice">
                <summary>Show invoice text</summary>
                <code data-testid="text-prepaid-invoice">{challenge.invoice}</code>
              </details>
            </div>
          </section>
        )}

        {complete && grant && (
          <section className="fn-pay fn-prepaid-done" aria-labelledby={`${id}-ok`} data-testid="panel-prepaid-success">
            <div className="fn-prepaid-seal" aria-hidden="true" />
            <p className="fn-kicker">Payment settled</p>
            <h3 id={`${id}-ok`} ref={successRef} tabIndex={-1} className="fn-h2 fn-prepaid-title">
              Success — {grant.credits} API credits minted
            </h3>
            <p className="fn-msg fn-msg-unavailable fn-prepaid-warn" role="alert" data-testid="text-macaroon-warning">
              Copy this Macaroon immediately. It grants 100 API calls and will not be displayed again. Pass this in your
              Authorization header as: <code>Macaroon &lt;token&gt;</code>.
            </p>
            <label className="fn-label" htmlFor={`${id}-tok`}>Macaroon</label>
            <textarea
              id={`${id}-tok`}
              className="fn-textarea fn-prepaid-token"
              readOnly
              rows={4}
              value={grant.macaroon}
              spellCheck={false}
              autoComplete="off"
              onFocus={(e) => e.currentTarget.select()}
              data-testid="text-macaroon"
            />
            <dl className="fn-facts">
              <div><dt>Credits</dt><dd data-testid="text-grant-credits">{grant.credits} calls</dd></div>
              <div><dt>Scope</dt><dd><code data-testid="text-grant-scope">POST {grant.scope}</code></dd></div>
              <div><dt>Paid</dt><dd>{grant.amount_sats.toLocaleString("en-US")} sats</dd></div>
              <div><dt>Valid until</dt><dd data-testid="text-grant-valid">{formatValidUntil(grant.valid_until)}</dd></div>
            </dl>
            <div className="fn-prepaid-actions">
              <button type="button" className="fn-btn fn-btn-primary" onClick={() => void copy(grant.macaroon, setTokenCopy)} data-testid="button-copy-macaroon">
                {tokenCopy === "copied" ? "Macaroon copied" : "Copy Macaroon"}
              </button>
              {!confirmDiscard ? (
                <button type="button" className="fn-btn fn-btn-quiet" onClick={() => setConfirmDiscard(true)} data-testid="button-discard-macaroon">
                  Discard from page
                </button>
              ) : null}
            </div>
            <p className="fn-sr" role="status">{tokenCopy === "copied" ? "Macaroon copied to clipboard." : ""}</p>
            {tokenCopy === "failed" && (
              <p className="fn-msg fn-msg-error" role="alert" data-testid="text-copy-failed">
                Copy failed: the clipboard is unavailable in this browser. Select the Macaroon above and copy it manually before discarding.
              </p>
            )}
            {confirmDiscard && (
              <div className="fn-msg fn-msg-error fn-prepaid-confirm" role="alertdialog" aria-labelledby={`${id}-dc`}>
                <strong id={`${id}-dc`}>Discard this Macaroon?</strong>
                <p>It cannot be shown again. If you have not saved it, the 100 credits become unreachable.</p>
                <div className="fn-prepaid-actions">
                  <button type="button" className="fn-btn" onClick={p.clear} data-testid="button-confirm-discard">Yes, discard</button>
                  <button type="button" className="fn-btn fn-btn-quiet" onClick={() => setConfirmDiscard(false)} data-testid="button-cancel-discard">Keep showing</button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
