// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect, useId, useState, type FormEvent } from "react";
import { CopyTextButton } from "./copy-text-button";

export const WAIVER_DISCLOSURE =
  "All prepaid MCP Macro-Macaroons, Scanner Packs, and AGPLv3 Commercial Copyright Waivers are 100% self-serve and provided STRICTLY AS-IS, WITH ALL FAULTS. Zero SLAs, zero uptime warranties, zero indemnity, zero custom MSAs, zero vendor questionnaires, and zero support obligations. Full source code is publicly inspectable under AGPLv3 for independent self-hosting. Payment for a Commercial Copyright Waiver strictly grants a time-locked, non-negotiable waiver from AGPLv3 Section 13 network source-disclosure requirements for the specified term, anchored cryptographically to your confirmed Bitcoin transaction.";

export type WaiverTier =
  | "swarm_monthly"
  | "swarm_annual"
  | "global_monthly"
  | "global_annual";

export const WAIVER_TIERS: {
  id: WaiverTier;
  scope: string;
  usd: number;
  days: number;
  note?: string;
}[] = [
  { id: "swarm_monthly", scope: "Single-Swarm", usd: 2500, days: 30 },
  { id: "swarm_annual", scope: "Single-Swarm", usd: 25000, days: 365, note: "16.7% annual discount" },
  { id: "global_monthly", scope: "Global Organization", usd: 25000, days: 30 },
  { id: "global_annual", scope: "Global Organization", usd: 250000, days: 365, note: "16.7% annual discount" },
];

type Quote = {
  quote_id: string;
  tier: WaiverTier;
  usd_basis: number;
  quoted_sats: number;
  btc_spot_usd: number;
  settlement_address: string;
  min_confirmations: number;
  expires_at: number | string;
  terms_sha256: string;
};

const BASE = import.meta.env.BASE_URL;
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

function toMs(v: number | string): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? toMs(n) : Date.parse(v);
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const d = data as { error?: unknown; message?: unknown } | null;
    const code = typeof d?.error === "string" ? d.error : `HTTP ${res.status}`;
    const msg = typeof d?.message === "string" ? `: ${d.message}` : "";
    throw new Error(explain(code, res.status) + msg);
  }
  return data;
}

function explain(code: string, status: number): string {
  if (code === "btc_spot_oracle_unavailable")
    return "BTC/USD spot oracle unavailable; no quote issued";
  if (code === "waiver_settlement_address_unconfigured")
    return "Waiver settlement is not configured on this server; no quote issued";
  if (status === 400) return `Request rejected (${code})`;
  if (status === 409) return `Settlement rejected (${code})`;
  return `Server error (${code})`;
}

function validQuote(q: unknown, tier: WaiverTier): q is Quote {
  const v = q as Quote | null;
  return (
    !!v &&
    typeof v.quote_id === "string" &&
    v.tier === tier &&
    Number.isSafeInteger(v.quoted_sats) &&
    v.quoted_sats > 0 &&
    typeof v.settlement_address === "string" &&
    v.settlement_address.length > 0 &&
    typeof v.terms_sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(v.terms_sha256) &&
    Number.isFinite(toMs(v.expires_at))
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function WaiverPurchase() {
  const id = useId();
  const [tier, setTier] = useState<WaiverTier>("swarm_monthly");
  const [name, setName] = useState("");
  const [ident, setIdent] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [txid, setTxid] = useState("");
  const [resumeId, setResumeId] = useState("");
  const [busy, setBusy] = useState<"" | "quote" | "claim">("");
  const [error, setError] = useState("");
  const [cert, setCert] = useState<string | null>(null);
  const now = useNow(!!quote && !cert);

  const expiresMs = quote ? toMs(quote.expires_at) : 0;
  const expired = !!quote && now >= expiresMs;
  const left = Math.max(0, Math.floor((expiresMs - now) / 1000));
  const txValid = /^[0-9a-f]{64}$/i.test(txid.trim());
  const canQuote = !busy && accepted && name.trim().length > 0 && ident.trim().length > 0;

  async function requestQuote(e: FormEvent) {
    e.preventDefault();
    if (!canQuote) return;
    setBusy("quote");
    setError("");
    try {
      const q = await post("api/v1/waivers/quote", {
        tier,
        licensee_name: name.trim(),
        licensee_identifier: ident.trim(),
        terms_accepted: accepted === true,
      });
      if (!validQuote(q, tier)) throw new Error("Malformed quote returned by server. Do not pay.");
      setQuote(q);
      setTxid("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quote failed.");
    } finally {
      setBusy("");
    }
  }

  async function claim(e: FormEvent) {
    e.preventDefault();
    const quoteId = quote?.quote_id ?? resumeId.trim();
    if (!/^[0-9a-f-]{36}$/.test(quoteId) || !txValid || busy) return;
    setBusy("claim");
    setError("");
    try {
      const c = await post("api/v1/waivers/claim", {
        quote_id: quoteId,
        txid: txid.trim().toLowerCase(),
      });
      const v = c as { signature?: unknown; txid?: unknown; waiver_id?: unknown } | null;
      if (!v || typeof v.signature !== "string" || typeof v.waiver_id !== "string" ||
          v.txid !== txid.trim().toLowerCase())
        throw new Error("Server returned an unsigned certificate. Verify the claim again.");
      setCert(JSON.stringify(c, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed.");
    } finally {
      setBusy("");
    }
  }

  function reset() {
    setQuote(null);
    setCert(null);
    setTxid("");
    setResumeId("");
    setError("");
  }

  function download() {
    if (!cert) return;
    const url = URL.createObjectURL(new Blob([cert], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `agpl-waiver-${quote?.quote_id ?? "certificate"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const selected = WAIVER_TIERS.find((t) => t.id === tier)!;
  const btc = quote ? (quote.quoted_sats / 1e8).toFixed(8) : "";

  return (
    <div className="wv" data-testid="panel-waiver-purchase">
      {!quote && !cert && (
        <form className="wv-form" onSubmit={requestQuote} noValidate>
          <fieldset className="wv-tiers">
            <legend>Waiver tier</legend>
            {WAIVER_TIERS.map((t) => (
              <label
                key={t.id}
                className={`wv-tier${tier === t.id ? " is-on" : ""}`}
                data-testid={`option-waiver-${t.id}`}
              >
                <input
                  type="radio"
                  name={`${id}-tier`}
                  value={t.id}
                  checked={tier === t.id}
                  onChange={() => setTier(t.id)}
                  data-testid={`radio-waiver-${t.id}`}
                />
                <span className="wv-tier-scope">{t.scope}</span>
                <span className="wv-tier-price">{usd(t.usd)}</span>
                <span className="wv-tier-term">
                  {t.days} days in BTC{t.note ? ` / ${t.note}` : ""}
                </span>
              </label>
            ))}
          </fieldset>
          <div className="wv-fields">
            <label className="wv-field">
              <span>Licensee name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
                autoComplete="organization"
                data-testid="input-licensee-name"
              />
            </label>
            <label className="wv-field">
              <span>Licensee identifier (domain, LEI or registry ID)</span>
              <input
                value={ident}
                onChange={(e) => setIdent(e.target.value)}
                maxLength={200}
                required
                data-testid="input-licensee-identifier"
              />
            </label>
          </div>
          <p className="wv-disclosure" data-testid="text-waiver-disclosure">
            {WAIVER_DISCLOSURE}
          </p>
          <label className="wv-ack">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              data-testid="checkbox-terms-accepted"
            />
            <span>
              I accept the AS-IS waiver terms above, with zero SLAs and zero
              support obligations.
            </span>
          </label>
          <button
            type="submit"
            className="elm-cta wv-submit"
            disabled={!canQuote}
            aria-busy={busy === "quote" || undefined}
            data-testid="button-waiver-quote"
          >
            {busy === "quote"
              ? "Locking BTC spot quote..."
              : `Quote ${usd(selected.usd)} ${selected.scope} waiver in BTC`}
          </button>
        </form>
      )}

      {!quote && !cert && (
        <details className="wv-quote">
          <summary>Recover a certificate for an existing quote</summary>
          <p>No new payment is required. Enter the saved quote ID and its transaction ID. The server checks the original settlement and licensee.</p>
          <form className="wv-claim" onSubmit={claim}>
            <label className="wv-field">
              <span>Original quote ID</span>
              <input value={resumeId} onChange={e => setResumeId(e.target.value)}
                spellCheck={false} autoComplete="off" data-testid="input-waiver-resume-id" />
            </label>
            <label className="wv-field">
              <span>Original transaction ID (64 hex)</span>
              <input value={txid} onChange={e => setTxid(e.target.value)}
                spellCheck={false} autoComplete="off" data-testid="input-waiver-resume-txid" />
            </label>
            <button type="submit" className="elm-cta wv-submit"
              disabled={!!busy || !txValid || !/^[0-9a-f-]{36}$/.test(resumeId.trim())}
              data-testid="button-waiver-resume">
              Recover certificate
            </button>
          </form>
        </details>
      )}
      {quote && !cert && (
        <section className="wv-quote" aria-labelledby={`${id}-q`} data-testid="panel-waiver-quote">
          <p className="elm-tier-label">Quote {quote.quote_id}</p>
          <CopyTextButton text={quote.quote_id} label="Copy quote ID"
            context="waiver quote recovery" description="Save the quote ID before paying"
            testId="button-copy-waiver-quote-id" />
          <p className="wv-status">Save this quote ID before paying. It lets you recover the certificate after closing this tab without paying again.</p>
          <h5 id={`${id}-q`} className="wv-amount" data-testid="text-waiver-sats">
            {quote.quoted_sats.toLocaleString("en-US")} <small>sats</small>
            <span className="wv-btc">{btc} BTC</span>
          </h5>
          <dl className="wv-facts">
            <div><dt>Tier</dt><dd data-testid="text-waiver-tier">{quote.tier}</dd></div>
            <div><dt>USD basis</dt><dd>{usd(quote.usd_basis)}</dd></div>
            <div><dt>BTC spot</dt><dd>{usd(quote.btc_spot_usd)}</dd></div>
            <div><dt>Confirmations</dt><dd>{quote.min_confirmations}</dd></div>
            <div className="wv-wide">
              <dt>Settlement address</dt>
              <dd className="wv-row">
                <code data-testid="text-waiver-address">{quote.settlement_address}</code>
                <CopyTextButton
                  text={quote.settlement_address}
                  label="Copy"
                  context="settlement address"
                  description="Copy settlement address"
                  testId="button-copy-waiver-address"
                  variant="compact"
                />
              </dd>
            </div>
            <div className="wv-wide">
              <dt>Terms SHA-256</dt>
              <dd><code data-testid="text-waiver-terms-hash">{quote.terms_sha256}</code></dd>
            </div>
          </dl>
          <p
            className={`wv-status${expired ? " is-bad" : ""}`}
            role="status"
            data-testid="status-waiver-quote"
          >
            {expired
              ? "Quote expired. Do not send funds against it; request a new quote. If you already broadcast a payment, submit its TXID below and the server will decide."
              : `Awaiting your on-chain payment. Quote locked for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}. Not paid until the server validates a confirmed transaction.`}
          </p>
          <form className="wv-claim" onSubmit={claim}>
            <label className="wv-field">
              <span>Transaction ID (64 hex)</span>
              <input
                value={txid}
                onChange={(e) => setTxid(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
                pattern="[0-9a-fA-F]{64}"
                data-testid="input-waiver-txid"
              />
            </label>
            <div className="wv-row">
              <button
                type="submit"
                className="elm-cta wv-submit"
                disabled={!txValid || !!busy}
                aria-busy={busy === "claim" || undefined}
                data-testid="button-waiver-claim"
              >
                {busy === "claim" ? "Verifying on-chain..." : "Verify payment and claim"}
              </button>
              <button type="button" className="wv-quiet" onClick={reset} data-testid="button-waiver-new-quote">
                New quote
              </button>
            </div>
          </form>
        </section>
      )}

      {cert && (
        <section className="wv-quote wv-cert" aria-labelledby={`${id}-c`} data-testid="panel-waiver-certificate">
          <p className="elm-tier-label">Server-validated settlement</p>
          <h5 id={`${id}-c`}>Signed Waiver Certificate issued</h5>
          <textarea
            className="wv-cert-text"
            readOnly
            rows={10}
            value={cert}
            spellCheck={false}
            data-testid="text-waiver-certificate"
          />
          <div className="wv-row">
            <CopyTextButton
              text={cert}
              label="Copy JSON"
              context="waiver certificate"
              description="Copy waiver certificate JSON"
              testId="button-copy-waiver-certificate"
            />
            <button type="button" className="wv-quiet" onClick={download} data-testid="button-download-waiver-certificate">
              Download JSON
            </button>
            <a
              className="wv-quiet"
              href={`${BASE}static/verify.html`}
              target="_blank"
              rel="noopener"
              data-testid="link-waiver-offline-verifier"
            >
              Open offline verifier
            </a>
            <button type="button" className="wv-quiet" onClick={reset} data-testid="button-waiver-done">
              Start another waiver
            </button>
          </div>
        </section>
      )}

      {error && (
        <p className="wv-status is-bad" role="alert" data-testid="text-waiver-error">
          {error}
        </p>
      )}
    </div>
  );
}
