// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect, useRef, useState } from "react";
import { Lock, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { CopyJsonButton } from "./CopyJsonButton";
import type { EscrowTollQuote } from "@workspace/api-client-react";
import { evaluateEscrowToll } from "../engine/escrowToll";
import {
  HEX64, callEscrow, preimageMatches, validateCreate, validateSettle,
  type CreateBody, type CreateResult, type L402Challenge, type SettleBody, type SettleResult,
} from "../engine/escrowLive";
import "./escrow-terminal.css";

type Pending =
  | { op: "create"; body: CreateBody; challenge: L402Challenge }
  | { op: "settle"; body: SettleBody; challenge: L402Challenge };

export function EscrowTerminal() {
  const [quote, setQuote] = useState<EscrowTollQuote | null>(null);
  const quoteSummary = quote
    ? `${quote.toll_fee_sats} sats (~$${quote.target_usd.toFixed(2)}; ${quote.source === "market" ? "dynamic market quote" : "fallback estimate"})`
    : "24 sats (~$0.02) fallback estimate · fetching live market quote…";
  const [token, setToken] = useState("");
  const [buyer, setBuyer] = useState("");
  const [worker, setWorker] = useState("");
  const [taskHash, setTaskHash] = useState("");
  const [amount, setAmount] = useState("");
  const [existingId, setExistingId] = useState("");
  const [trace, setTrace] = useState("");
  const [result, setResult] = useState("");
  const [contract, setContract] = useState<CreateResult | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [preimage, setPreimage] = useState("");
  const [settled, setSettled] = useState<SettleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastAction, setLastAction] = useState<(() => void) | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const tokenRef = useRef(token);
  const busyRef = useRef(false);
  tokenRef.current = token;

  useEffect(() => {
    const c = new AbortController();
    ctl.current = c;
    void evaluateEscrowToll(c.signal).then((v) => { if (!c.signal.aborted) setQuote(v); }).catch(() => undefined);
    return () => { c.abort(); };
  }, []);

  const signal = () => ctl.current?.signal ?? new AbortController().signal;

  const finishCreate = (data: CreateResult) => {
    setContract(data); setExistingId(data.escrow_id); setPending(null); setPreimage("");
  };

  const runCreate = async (body: CreateBody, auth: { macaroon: string; preimage: string } | null) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const s = signal();
    setBusy(true); setError("");
    try {
      const out = await callEscrow("/v1/escrow/create", body, tokenRef.current, auth, s, validateCreate);
      if (s.aborted) return;
      if (out.kind === "ok") finishCreate(out.data);
      else if (out.kind === "challenge") { setPending({ op: "create", body, challenge: out.challenge }); setPreimage(""); }
      else { setError(out.message); setLastAction(() => () => void runCreate(body, auth)); }
    } catch { /* aborted */ } finally { busyRef.current = false; if (!s.aborted) setBusy(false); }
  };

  const runSettle = async (body: SettleBody, auth: { macaroon: string; preimage: string } | null) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const s = signal();
    setBusy(true); setError("");
    try {
      const out = await callEscrow("/v1/escrow/settle", body, tokenRef.current, auth, s,
        (json) => {
          const data = validateSettle(json);
          return data?.article_12_receipt.escrow_id === body.escrow_id ? data : null;
        });
      if (s.aborted) return;
      if (out.kind === "ok") { setSettled(out.data); setPending(null); setPreimage(""); }
      else if (out.kind === "challenge") { setPending({ op: "settle", body, challenge: out.challenge }); setPreimage(""); }
      else { setError(out.message); setLastAction(() => () => void runSettle(body, auth)); }
    } catch { /* aborted */ } finally { busyRef.current = false; if (!s.aborted) setBusy(false); }
  };

  const createErrors = (): string | null => {
    if (!token) return "Operator token required";
    if (![buyer, worker, taskHash].every((h) => HEX64.test(h))) return "Pubkeys and task hash must be 64 lowercase hex";
    if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) < 1) return "Amount must be a positive integer";
    return null;
  };

  const onCreate = () => {
    if (contract || pending) return;
    const err = createErrors();
    if (err) { setError(err); setLastAction(null); return; }
    void runCreate({ buyer_pubkey: buyer, worker_pubkey: worker, task_hash: taskHash, amount_sats: Number(amount) }, null);
  };

  const onUseExisting = () => {
    const id = existingId.trim();
    if (!id) { setError("Enter an escrow_id"); setLastAction(null); return; }
    setContract(null); setSettled(null); setError("");
    setExistingId(id);
  };

  const escrowId = contract?.escrow_id ?? existingId.trim();

  const onSettle = () => {
    if (pending) return;
    if (!token) { setError("Operator token required"); setLastAction(null); return; }
    if (!escrowId || !trace.trim() || !result.trim()) { setError("escrow_id, execution trace and result payload are required"); setLastAction(null); return; }
    void runSettle({ escrow_id: escrowId, execution_trace: trace, result_payload: result }, null);
  };

  const onSubmitPreimage = async () => {
    if (!pending) return;
    const p = preimage.trim().toLowerCase();
    if (!(await preimageMatches(p, pending.challenge.payment_hash))) {
      setError("Preimage does not hash (SHA-256) to the challenge payment_hash. Nothing was sent."); setLastAction(null); return;
    }
    const auth = { macaroon: pending.challenge.macaroon, preimage: p };
    if (pending.op === "create") void runCreate(pending.body, auth);
    else void runSettle(pending.body, auth);
  };

  const exportJson = settled
    ? JSON.stringify({ create_response: contract, settle_response: settled }, null, 2)
    : null;
  const verifiedToll = settled?.article_12_receipt.lightning_settlement?.amount_sats ?? 0;
  const stage = settled ? 3 : contract || existingId.trim() ? 2 : pending?.op === "create" ? 1 : 0;
  const st = (n: number) => (stage > n ? "done" : stage === n ? "active" : "idle");
  const inp = (id: string, label: string, v: string, set: (s: string) => void, extra: Record<string, unknown> = {}) => (
    <label className="et-field">
      <span>{label}</span>
      <input value={v} onChange={(e) => set(e.target.value)} data-testid={`input-${id}`} spellCheck={false}
        autoComplete="off" disabled={busy} {...extra} />
    </label>
  );

  return (
    <section className="escrow-term" aria-labelledby="escrow-h" data-testid="panel-escrow">
      <div className="section-kicker">Live REST Escrow Terminal</div>
      <h2 id="escrow-h">Live REST Escrow · Proof-of-Execution Oracle (L402 + RFC 6962)</h2>
      <p className="et-sub">Real Lightning Network micropayments via L402 and Nostr Wallet Connect (NWC). Create an escrow, pay the server-issued L402 invoice with your own wallet, and settle against the live server.</p>
      <div className="et-tags" aria-live="polite">
        {settled
          ? <span className="et-tag et-ok" data-testid="badge-settled">SERVER CONFIRMED: {settled.status}</span>
          : <span className="et-tag" data-testid="badge-awaiting">AWAITING LIVE CONFIRMATION</span>}
        <span className="et-tag">LOCKED = LOCAL SERVER COMMITMENT · NO BITCOIN ANCHOR · RECEIPT IS NOT LEGAL CERTIFICATION</span>
      </div>

      <div className="et-form">
        {inp("operator-token", "Operator token (X-Escrow-Operator-Token, kept in memory only)", token, setToken, { type: "password" })}
      </div>

      <div className="et-steps">
        <div className="et-step" data-state={st(0)} data-testid="stage-1">
          <div className="section-kicker">1 Create escrow</div>
          <p>Creation requires an L402 access fee; the server-quoted invoice amount is authoritative.
            {` Settlement toll preview: ${quoteSummary}.`}</p>
          {inp("buyer-pubkey", "Buyer pubkey (64 hex)", buyer, (s) => setBuyer(s.trim().toLowerCase()))}
          {inp("worker-pubkey", "Worker pubkey (64 hex)", worker, (s) => setWorker(s.trim().toLowerCase()))}
          {inp("task-hash", "Task hash (64 hex)", taskHash, (s) => setTaskHash(s.trim().toLowerCase()))}
          {inp("amount-sats", "Amount (sats)", amount, (s) => setAmount(s.trim()), { inputMode: "numeric" })}
          <button type="button" className="sim-run" onClick={onCreate} disabled={busy || !!contract || !!pending}
            data-testid="button-create-escrow"><Lock size={15} aria-hidden="true" /> Create escrow</button>
        </div>

        <div className="et-step" data-state={st(1)} data-testid="stage-2">
          <div className="section-kicker">2 Contract</div>
          {contract ? (
            <div data-testid="text-contract">
              <span className="et-tag">{contract.status} (local commitment)</span>
              <p><code>escrow_id {contract.escrow_id}</code></p>
              <p><code>payment_hash {contract.payment_hash}</code></p>
              <p>Amount {contract.amount_sats} sats · Settle toll from contract: <strong data-testid="text-contract-toll">{contract.toll_fee_sats} sats</strong></p>
            </div>
          ) : <p>No contract created in this session. Recover an existing one to retry settlement without creating again.</p>}
          {inp("escrow-id", "Existing escrow_id (recovery)", existingId, setExistingId, { disabled: busy || !!contract })}
          {!contract && <button type="button" className="control-button" onClick={onUseExisting} disabled={busy}
            data-testid="button-use-existing-escrow">Use existing escrow_id</button>}
        </div>

        <div className="et-step" data-state={st(2)} data-testid="stage-3">
          <div className="section-kicker">3 Settle</div>
          <p>Settle is charged exactly the contract toll_fee_sats; no separate access fee.</p>
          <label className="et-field"><span>Execution trace</span>
            <textarea value={trace} onChange={(e) => setTrace(e.target.value)} rows={3} disabled={busy}
              data-testid="input-execution-trace" /></label>
          <label className="et-field"><span>Result payload</span>
            <textarea value={result} onChange={(e) => setResult(e.target.value)} rows={3} disabled={busy}
              data-testid="input-result-payload" /></label>
          <button type="button" className="sim-run" onClick={onSettle} disabled={busy || !!pending || !!settled || !escrowId}
            data-testid="button-settle-escrow"><Send size={15} aria-hidden="true" /> Request settlement</button>
          {settled && <p><code data-testid="text-preimage">preimage {settled.preimage}</code></p>}
          {settled && <p><code data-testid="text-merkle-root">merkle_root {settled.merkle_root}</code></p>}
        </div>
      </div>

      {pending && (
        <div className="et-pay" data-testid="panel-l402-challenge" role="region" aria-label="Payment required">
          <div className="section-kicker">Payment required for {pending.op} · {pending.challenge.amount_sats} sats</div>
          <p>Pay this invoice with your own Lightning wallet, then paste the payment preimage it returns. The preimage is verified locally before the identical request is retried.</p>
          <pre tabIndex={0} data-testid="text-invoice">{pending.challenge.invoice}</pre>
          <p><code data-testid="text-challenge-hash">payment_hash {pending.challenge.payment_hash}</code></p>
          <label className="et-field"><span>Payer preimage (64 hex)</span>
            <input value={preimage} onChange={(e) => setPreimage(e.target.value.trim())} spellCheck={false} autoComplete="off"
              disabled={busy} data-testid="input-preimage" /></label>
          <div className="et-actions">
            <button type="button" className="sim-run" onClick={() => void onSubmitPreimage()} disabled={busy || !preimage}
              data-testid="button-submit-preimage"><ShieldCheck size={15} aria-hidden="true" /> Verify and retry request</button>
            <button type="button" className="control-button" onClick={() => { setPending(null); setPreimage(""); }} disabled={busy}
              data-testid="button-discard-challenge">Discard challenge</button>
          </div>
        </div>
      )}

      <div className="et-actions">
        <span className="et-metric" data-testid="metric-tolls" role="status">
          Verified settle toll accrued: {verifiedToll} sats
        </span>
        <span className="et-baseline" data-testid="metric-current-toll" role="status">
          Settlement toll preview: {quoteSummary}. Server-issued invoice and contract prices are authoritative.
        </span>
        {busy && <span className="et-baseline" role="status" data-testid="status-busy">Contacting server…</span>}
        <CopyJsonButton text={exportJson} testId="button-copy-escrow-proof"
          label="Copy Server Receipt (JSON)" copiedLabel="Copied to Clipboard!" />
      </div>

      {error && <div className="et-err" role="alert" data-testid="text-escrow-error">{error}{" "}
        {lastAction && <button type="button" className="control-button" onClick={lastAction} disabled={busy}
          data-testid="button-retry-escrow"><RotateCcw size={13} aria-hidden="true" /> Retry</button>}</div>}

      {settled && (
        <>
          <div className="section-kicker">Server response · Article 12 receipt (record-keeping aid, not legal certification)</div>
          <pre tabIndex={0} data-testid="text-escrow-proof">{exportJson}</pre>
        </>
      )}
    </section>
  );
}
