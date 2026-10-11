// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { CopyJsonButton } from "./CopyJsonButton";
import type { EscrowTollQuote } from "@workspace/api-client-react";
import { evaluateEscrowToll } from "../engine/escrowToll";
import "./escrow-terminal.css";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b as ArrayBuffer), (x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (b: Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", b as BufferSource));
const rand = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const wait = (ms: number, s: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (s.aborted) {
      rej(new DOMException("aborted", "AbortError"));
      return;
    }
    const abort = () => {
      window.clearTimeout(t);
      s.removeEventListener("abort", abort);
      rej(new DOMException("aborted", "AbortError"));
    };
    const t = window.setTimeout(() => {
      s.removeEventListener("abort", abort);
      res();
    }, ms);
    s.addEventListener("abort", abort, { once: true });
  });

type Run = {
  taskHash: string; contractId: string; trace: string; resultHash: string; leaf: string;
  preimage: string; json: string;
};

export function EscrowTerminal() {
  const [stage, setStage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toll, setToll] = useState(0n);
  const [quote, setQuote] = useState<EscrowTollQuote | null>(null);
  const [run, setRun] = useState<Partial<Run>>({});
  const [done, setDone] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const quoteCtl = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    quoteCtl.current = c;
    void evaluateEscrowToll(c.signal).then((value) => {
      if (!c.signal.aborted) setQuote(value);
    }).catch(() => undefined);
    return () => { c.abort(); ctl.current?.abort(); };
  }, []);

  const start = async () => {
    if (ctl.current) return;
    const c = new AbortController();
    ctl.current = c;
    quoteCtl.current?.abort();
    setBusy(true); setError(""); setDone(null); setRun({}); setStage(0); setQuote(null);
    try {
      const evaluatedQuote = await evaluateEscrowToll(c.signal);
      if (c.signal.aborted) return;
      setQuote(evaluatedQuote);
      const tollSats = evaluatedQuote.toll_fee_sats;
      const contractId = "SAMPLE-" + rand(4).toUpperCase();
      const taskHash = await sha(enc.encode("task:model-fine-tuning-verification:" + contractId));
      if (c.signal.aborted) return;
      setRun({ contractId, taskHash }); setStage(1);
      await wait(900, c.signal);
      const resultHash = await sha(enc.encode("sample-fine-tuning-result:" + contractId));
      const traceRecord = { agent: "B", contract: contractId, resultHash };
      const traceBytes = enc.encode(JSON.stringify(traceRecord));
      const trace = await sha(traceBytes);
      if (c.signal.aborted) return;
      setRun((r) => ({ ...r, trace, resultHash })); setStage(2);
      await wait(900, c.signal);
      const leafIn = new Uint8Array(traceBytes.length + 1);
      leafIn.set(traceBytes, 1);
      const leaf = await sha(leafIn);
      const preimage = rand(32);
      if (c.signal.aborted) return;
      setRun((r) => ({ ...r, leaf }));
      await wait(700, c.signal);
      const json = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Report",
        author: { "@type": "Person", name: "Charles R. Strogish" },
        name: "Illustrative Article 12 receipt preview (SAMPLE / CLIENT SIMULATION)",
        disclaimer: "Illustrative only. Not certified as EU AI Act Article 12 compliance. No real payment. No Bitcoin anchor.",
        contractId, taskHash, traceRecord, resultHash, traceSha256: trace,
        rfc6962: { leafHash: leaf, singleLeafRoot: leaf, leafPrefix: "0x00", treeSize: 1, leafIndex: 0, inclusionPath: [] },
        illustrativePreimage: preimage,
        tollSats, pricing: evaluatedQuote,
        bountySats: 1000, anchor: null, simulated: true,
      }, null, 2);
      if (c.signal.aborted) return;
      const full = { contractId, taskHash, trace, resultHash, leaf, preimage, json };
      setRun(full); setDone(full); setStage(3); setToll((t) => t + BigInt(tollSats));
    } catch (e) {
      if (c.signal.aborted) return;
      setError((e as Error).message || "Simulation failed"); setStage(0);
    } finally {
      if (!c.signal.aborted) {
        ctl.current = null;
        setBusy(false);
      }
    }
  };

  const st = (n: number) => (stage >= n + 1 ? "done" : stage === n ? "active" : "idle");
  return (
    <section className="escrow-term" aria-labelledby="escrow-h" data-testid="panel-escrow">
      <div className="section-kicker">Autonomous Agent Escrow Terminal</div>
      <h2 id="escrow-h">Autonomous Proof-of-Execution Escrow Oracle (L402 + RFC 6962)</h2>
      <p className="et-sub">Machine-native conditional micro-settlement for autonomous agent-to-agent delegation.</p>
      <div className="et-tags" aria-live="polite">
        <span className="et-tag">SAMPLE / CLIENT SIMULATION</span>
        {done && <span className="et-tag et-ok" data-testid="badge-settled">SETTLED &amp; NOTARIZED</span>}
        <span className="et-tag">NO REAL PAYMENT / NO BITCOIN ANCHOR / NOT LEGAL CERTIFICATION</span>
      </div>
      <div className="et-steps">
        <div className="et-step" data-state={st(0)} data-testid="stage-1">
          <div className="section-kicker">1 Bounty Lock</div>
          <p>Agent A Locks 1,000 Sats (Contract: Model Fine-Tuning Verification)</p>
          {run.contractId && <span className="et-tag">{run.contractId}</span>}
          {run.taskHash && <p><code>task {run.taskHash}</code></p>}
        </div>
        <div className="et-step" data-state={st(1)} data-testid="stage-2">
          <div className="section-kicker">2 Work Submission</div>
          <p>Agent B Submits Deterministic Execution Trace + Result Hash</p>
          {run.trace && <p><code data-testid="text-trace-digest">sha256 {run.trace}</code></p>}
          {run.resultHash && <p><code>result {run.resultHash}</code></p>}
        </div>
        <div className="et-step" data-state={st(2)} data-testid="stage-3">
          <div className="section-kicker">3 Settlement &amp; Toll</div>
          <p>Stratigraphy Hub Validates RFC 6962 Leaf → Releases Payment Preimage →{" "}
            {quote
              ? `Collects ${quote.toll_fee_sats} Sats Toll (${quote.source === "market" ? "Dynamic ~$0.02 USD" : "Fallback"})`
              : "Evaluating Dynamic Toll…"}</p>
          {stage === 2 && <div className="et-leaf-generation" role="status">
            <span aria-hidden="true" /> Generating RFC 6962 leaf…
          </div>}
          {run.leaf && <p><code>leaf (0x00) = root {run.leaf}</code></p>}
          {done && (
            <>
              <p><code data-testid="text-preimage">{done.preimage}</code></p>
              <span className="et-tag et-ok">SETTLED &amp; NOTARIZED (SIMULATED)</span>
            </>
          )}
        </div>
      </div>
      <div className="et-actions">
        <button type="button" className="sim-run" onClick={start} disabled={busy} data-testid="button-simulate-settlement">
          <Play size={15} aria-hidden="true" /> Simulate Agent Settlement
        </button>
        <span className="et-metric" data-testid="metric-tolls" role="status">
          Automated Protocol Tolls Accrued: {toll.toString()} sats
        </span>
        <span className="et-baseline" data-testid="metric-current-toll" role="status">
          {quote ? `Current evaluated toll: ${quote.toll_fee_sats} sats` : "Evaluating current toll…"}
        </span>
        <span className="et-baseline">Simulated only · session baseline: 0 sats</span>
        <CopyJsonButton text={done ? done.json : null} testId="button-copy-escrow-proof"
          label="Copy Escrow Proof (JSON)" copiedLabel="Copied to Clipboard!" />
      </div>
      {error && <div className="et-err" role="alert">Simulation failed: {error}{" "}
        <button type="button" className="control-button" onClick={start}>Retry</button></div>}
      {done && (
        <>
          <div className="section-kicker">Article 12 receipt preview (illustrative, not compliance-certifying)</div>
          <pre tabIndex={0} data-testid="text-escrow-proof">{done.json}</pre>
        </>
      )}
    </section>
  );
}
