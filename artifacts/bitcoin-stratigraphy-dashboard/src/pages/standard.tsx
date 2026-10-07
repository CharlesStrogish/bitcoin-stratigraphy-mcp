import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Check, Copy, FileUp, Loader2, ShieldAlert, X } from "lucide-react";
import { TrustBadges } from "@/components/trust-badges";
import EnterpriseLicenseLink from "@/components/enterprise-license-link";
import type { AuditReport } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL;
const MAX = 1048576;

const REQS: [string, string, string][] = [
  [
    "R1",
    "MUST",
    "Each AI execution step MUST be recorded as a trace containing agent identity claim, UTC timestamp and the input/output context.",
  ],
  [
    "R2",
    "MUST",
    "Each completed canonical trace MUST be SHA-256 hashed and submitted for OpenTimestamps anchoring. Pending calendar acceptance is provisional; only independently checked Bitcoin inclusion may be called confirmed.",
  ],
  [
    "R3",
    "MUST",
    "Logs MUST be append-only. Verifiers MUST flag detectable chain breaks and digest mismatches. Externally retained checkpoints and expected-record manifests MUST protect against truncation and wholesale rewriting.",
  ],
  [
    "R4",
    "MUST",
    "A verification result MUST distinguish verified, pending, tamper, missing and unavailable. Only verified may be presented as confirmed.",
  ],
  [
    "R5",
    "SHOULD",
    "Vendors SHOULD provide original logs and proofs to authorized auditors under governed access so verification can be repeated without vendor cooperation.",
  ],
  [
    "R6",
    "SHOULD",
    "Verifiers SHOULD validate block headers against the verifier's own Bitcoin Core node on mainnet.",
  ],
  [
    "R7",
    "SHOULD",
    "Logs SHOULD exclude personal and secret data, or store only digests of such content.",
  ],
];
const ART12: [string, string][] = [
  [
    "Automatic logging (Art. 12(1))",
    "High-risk systems must technically allow automatic recording of events over their lifetime. R1 and R2 support automatic capture and independently checkable commitments. UTC event times remain producer claims.",
  ],
  [
    "Traceability (Art. 12(2))",
    "Logs must enable tracing of situations that may present risk or substantial modification. Agent identity claims, digests and block heights support reconstruction of event order.",
  ],
  [
    "Lifecycle",
    "Anchoring is continuous, so integrity evidence covers the system's operation period rather than a single audit snapshot. Retention duration remains the deployer's obligation.",
  ],
  [
    "Limitations",
    "Anchoring binds the exact supplied bytes to a Bitcoin block commitment. It does not prove uninterrupted custody, completeness, accuracy, lawful processing, or that the system is compliant.",
  ],
];
const CLAUSE = `All autonomous third-party agents deployed in production shall utilize State-Anchored AI OpenTimestamps notarization to support cryptographic log integrity. Supplier shall maintain automatic, append-only logs of each execution of the AI System, submit SHA-256 digests of completed canonical traces for Bitcoin anchoring, retain original logs and independently verifiable proofs, and protect against truncation through externally retained checkpoints. Supplier shall provide logs and proofs to Customer's authorized auditors under agreed confidentiality and retention terms. A cryptographic mismatch shall be notified as an integrity incident within [__] days; pending calendar confirmation or unavailable verification alone is not a cryptographic mismatch. Confirmation and availability service levels shall be agreed separately. Conformance with the proposed SA-AI specification is a contractual undertaking, not regulatory certification or a guarantee of compliance with Regulation (EU) 2024/1689.`;

function useCopy() {
  const [k, setK] = useState("");
  return [
    k,
    (key: string, t: string) => {
      void navigator.clipboard
        ?.writeText(t)
        .then(() => {
          setK(key);
          setTimeout(() => setK(""), 1800);
        })
        .catch(() => {});
    },
  ] as const;
}

function Block({
  id,
  title,
  text,
  copied,
  onCopy,
}: {
  id: string;
  title: string;
  text: string;
  copied: string;
  onCopy: (k: string, t: string) => void;
}) {
  return (
    <div className="sa-block">
      <div className="sa-block-head">
        <span>{title}</span>
        <button
          className="control-button"
          onClick={() => onCopy(id, text)}
          data-testid={`button-copy-${id}`}
        >
          {copied === id ? <Check size={13} /> : <Copy size={13} />}
          {copied === id ? "Copied" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0}>{text}</pre>
    </div>
  );
}

const TONE: Record<string, string> = {
  verified: "ok",
  pending: "warn",
  tamper: "bad",
  missing: "neutral",
  unavailable: "neutral",
};

function errMsg(status: number) {
  if (status === 400)
    return "The server could not parse the input (400). Check that each line is valid JSON matching the trace schema.";
  if (status === 413)
    return "Input exceeds 1 MiB (413). Use the local CLI or original bounded journal shards; do not split an existing hash chain.";
  if (status === 429)
    return "Too many requests (429). Wait a moment and retry.";
  if (status === 503)
    return "Verification service temporarily unavailable (503). Retry shortly.";
  return `Unexpected response (${status}).`;
}

function Verifier() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [report, setReport] = useState<AuditReport | null>(null);
  const [drag, setDrag] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const reset = () => {
    setReport(null);
    setErr("");
  };
  const pick = (f: File | null) => {
    if (busy) return;
    reset();
    setText("");
    if (f && f.size > MAX) {
      setFile(null);
      setErr("File exceeds the 1 MiB limit.");
      return;
    }
    setFile(f);
  };
  const hasInput = !!file || text.trim().length > 0;

  const submit = async () => {
    if (busy || !ack) return;
    reset();
    let body: string | File;
    let contentType = "application/x-ndjson";
    if (file) {
      if (file.size === 0) {
        setErr("The selected file is empty.");
        return;
      }
      body = file;
    } else {
      const t = text.trim();
      if (!t) {
        setErr("Provide a file or paste JSON before submitting.");
        return;
      }
      // Preserve duplicate keys and numeric spellings for strict server parsing.
      body = t;
      if (new Blob([body]).size > MAX) {
        setErr("Input exceeds the 1 MiB limit.");
        return;
      }
    }
    try {
      const parsed = JSON.parse(
        typeof body === "string" ? body : await body.text(),
      );
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.trace &&
        !parsed.kind
      ) {
        contentType = "application/json";
      }
    } catch {
      /* Multiple journal records remain NDJSON. */
    }
    if (!navigator.onLine) {
      setErr("You appear to be offline. Reconnect and retry.");
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    try {
      const res = await fetch(`${BASE}api/audit/verify`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body,
        signal: ac.signal,
        credentials: "omit",
      });
      if (!res.ok) {
        setErr(errMsg(res.status));
        return;
      }
      setReport((await res.json()) as AuditReport);
    } catch (e) {
      if ((e as Error).name === "AbortError") setErr("Verification cancelled.");
      else setErr("Network error: the server could not be reached.");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="sa-verify">
      <div className="sa-warn" role="note">
        <ShieldAlert size={18} />
        <p>
          <strong>Before you submit.</strong> Logs can contain sensitive
          content. Submitted bytes are sent transiently to the server for
          verification; the backend stores no journal. Prefer the offline
          cookbook for confidential data.
        </p>
      </div>
      <div className="sa-grid2">
        <div
          className={`sa-drop ${drag ? "is-drag" : ""}`}
          data-testid="dropzone-file"
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files[0] ?? null);
          }}
        >
          <FileUp size={26} />
          <strong>{file ? file.name : "Drop a .jsonl or .txt journal"}</strong>
          <span>
            {file
              ? `${file.size.toLocaleString()} bytes`
              : "Up to 1 MiB, 32 traces / 128 records"}
          </span>
          <div className="sa-row">
            <button
              className="control-button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              data-testid="button-choose-file"
            >
              Choose file
            </button>
            {file && (
              <button
                className="control-button"
                onClick={() => pick(null)}
                disabled={busy}
                data-testid="button-remove-file"
              >
                <X size={13} />
                Remove
              </button>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".jsonl,.ndjson,.json,.txt,text/plain"
            hidden
            aria-label="Choose journal file"
            onChange={(e) => {
              pick(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
        </div>
        <div>
          <label htmlFor="sa-raw" className="sa-lab">
            Or paste raw JSON / JSONL
          </label>
          <textarea
            id="sa-raw"
            className="sa-text"
            rows={8}
            spellCheck={false}
            disabled={!!file || busy}
            placeholder={
              file
                ? "File selected. Remove it to paste text."
                : '{"trace":{...},"otsProofHex":"..."}'
            }
            value={text}
            onChange={(e) => {
              reset();
              setText(e.target.value);
            }}
            data-testid="input-raw-json"
          />
        </div>
      </div>
      <label className="sa-ack">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          disabled={busy}
          data-testid="checkbox-acknowledge"
        />{" "}
        I understand this content is sent to the server transiently and may
        include sensitive data.
      </label>
      <div className="sa-row">
        <button
          className="sa-primary"
          onClick={submit}
          disabled={busy || !ack || !hasInput}
          data-testid="button-verify"
        >
          {busy ? (
            <>
              <Loader2 size={14} className="spin" /> Verifying
            </>
          ) : (
            "Verify evidence"
          )}
        </button>
        {busy && (
          <button
            className="control-button"
            onClick={() => abortRef.current?.abort()}
            data-testid="button-cancel"
          >
            Cancel
          </button>
        )}
        {!ack && hasInput && (
          <span className="sa-hint">
            Acknowledge the notice to enable upload.
          </span>
        )}
        {!hasInput && (
          <span className="sa-hint">Add a file or text to begin.</span>
        )}
      </div>
      <div aria-live="polite">
        {busy && (
          <div className="sa-skel" aria-label="Verifying">
            <i />
            <i />
            <i />
          </div>
        )}
        {err && (
          <div className="sa-err" role="alert" data-testid="text-error">
            {err}
            <button
              className="control-button"
              onClick={submit}
              disabled={busy || !ack || !hasInput}
            >
              Retry
            </button>
          </div>
        )}
        {report && <Report r={report} />}
      </div>
    </div>
  );
}

function Report({ r }: { r: AuditReport }) {
  return (
    <div className="sa-report" data-testid="report-audit">
      <div className="sa-meta">
        <span>
          Generated <b>{r.generatedUtc}</b>
        </span>
        <span>
          Scope <b>{r.scope}</b>
        </span>
        <span>
          Method <b>{r.method}</b>
        </span>
        <span>
          Journal integrity{" "}
          <b
            className={`sa-tag ${r.journalIntegrity === "tamper" ? "bad" : r.journalIntegrity === "consistent" ? "ok" : "neutral"}`}
          >
            {r.journalIntegrity.replace("_", " ")}
          </b>
        </span>
        <span>
          Exit code <b>{r.exitCode}</b>
        </span>
      </div>
      {r.issues.length > 0 && (
        <ul className="sa-issues">
          {r.issues.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      )}
      {r.traces.length === 0 ? (
        <p className="sa-hint">No traces were returned.</p>
      ) : (
        <div className="table-scroll">
          <table style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Trace</th>
                <th>Timestamp (UTC)</th>
                <th>Agent (claimed)</th>
                <th>SHA-256</th>
                <th>Block</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {r.traces.map((t, i) => (
                <tr key={`${t.traceId}-${i}`}>
                  <td>
                    <span className={`sa-tag ${TONE[t.status] ?? "neutral"}`}>
                      {t.label || t.status}
                    </span>
                  </td>
                  <td>
                    <code>{t.traceId}</code>
                  </td>
                  <td>
                    <code>{t.timestampUtc}</code>
                  </td>
                  <td>{t.agentId}</td>
                  <td>
                    <code className="sa-hash">{t.sha256}</code>
                  </td>
                  <td>
                    <code>{t.blockHeight ?? "n/a"}</code>
                  </td>
                  <td>{t.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="sa-limits">
        <strong>Limitations.</strong> {r.limitations}
      </p>
    </div>
  );
}

export default function StandardPage() {
  const [copied, copy] = useCopy();
  useEffect(() => {
    const prev = document.title;
    document.title =
      "SA-AI Proposed Specification: Verifiable AI Log Evidence | Bitcoin Stratigraphy";
    let m = document.querySelector('meta[name="description"]');
    const old = m?.getAttribute("content") ?? null;
    if (!m) {
      m = document.createElement("meta");
      m.setAttribute("name", "description");
      document.head.appendChild(m);
    }
    m.setAttribute(
      "content",
      "Proposed State-Anchored AI specification: MUST/SHOULD requirements, EU AI Act Article 12 mapping, sample MSA clause, trust badge and a free independent log verifier.",
    );
    return () => {
      document.title = prev;
      if (old !== null) m!.setAttribute("content", old);
    };
  }, []);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const img = `${origin}${BASE}state-anchored-ai.svg`;
  const page = `${origin}${BASE}standard`;
  const badge = `[![State-Anchored AI: Adopted](${img})](${page})`;
  return (
    <div className="app-shell sa-page">
      <div className="shell-inner">
        <header className="topbar">
          <div className="eyebrow">
            <span className="eyebrow-line" /> SA-AI / PROPOSED SPECIFICATION /
            DRAFT
          </div>
          <div className="header-main">
            <div>
              <h1>
                State-Anchored <span>AI</span>
              </h1>
              <p className="subtitle">
                Independently checkable log-integrity evidence for procurement
                teams, in place of unverifiable vendor assurances. SA-AI is a
                proposed vendor specification. It is not regulator-endorsed, not
                a certification, not a globally recognized standard, and not a
                guarantee of EU AI Act Article 12 compliance.
              </p>
              <TrustBadges />
            </div>
            <div className="header-actions">
              <EnterpriseLicenseLink />
              <Link
                href="/"
                className="control-button"
                data-testid="link-dashboard"
              >
                Back to dashboard
              </Link>
            </div>
          </div>
        </header>
        <nav className="sa-toc" aria-label="On this page">
          {[
            ["req", "Requirements"],
            ["art12", "Article 12"],
            ["msa", "MSA clause"],
            ["badge", "Badge"],
            ["verify", "Verifier"],
            ["indep", "Independence"],
            ["licensing", "Licensing & IP"],
          ].map(([h, l]) => (
            <a key={h} href={`#${h}`}>
              {l}
            </a>
          ))}
        </nav>
        <main className="sa-main">
          <section id="req" className="panel sa-sec">
            <h2>1. Requirements</h2>
            <p className="sa-hint">
              Key words MUST and SHOULD are used in the sense of RFC 2119.
            </p>
            <ol className="sa-reqs">
              {REQS.map(([id, lvl, t]) => (
                <li key={id}>
                  <code>{id}</code>
                  <span className={`sa-lvl ${lvl === "MUST" ? "must" : ""}`}>
                    {lvl}
                  </span>
                  <p>{t}</p>
                </li>
              ))}
            </ol>
          </section>
          <section id="art12" className="panel sa-sec">
            <h2>2. EU AI Act Article 12 mapping</h2>
            <p>
              Reference:{" "}
              <a
                href="https://eur-lex.europa.eu/eli/reg/2024/1689/oj"
                target="_blank"
                rel="noreferrer"
              >
                Regulation (EU) 2024/1689, Article 12 (Record-keeping), EUR-Lex
              </a>
              . The mapping is informational. Conformance with SA-AI does not
              guarantee Article 12 compliance.
            </p>
            <dl className="sa-dl">
              {ART12.map(([a, b]) => (
                <div key={a}>
                  <dt>{a}</dt>
                  <dd>{b}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section id="msa" className="panel sa-sec">
            <h2>3. Corporate Procurement: sample MSA clause</h2>
            <p className="sa-hint">
              Draft for counsel review. Not legal advice.
            </p>
            <Block
              id="msa"
              title="Sample clause"
              text={CLAUSE}
              copied={copied}
              onCopy={copy}
            />
          </section>
          <section id="badge" className="panel sa-sec">
            <h2>4. Trust badge</h2>
            <div className="sa-warn">
              <ShieldAlert size={18} />
              <p>
                <strong>Self-asserted adoption. Not certification.</strong> This
                static badge is not per-project or live verification and never
                proves that any repository or vendor was verified. Verify
                evidence with the tool below.
              </p>
            </div>
            <img
              src={`${BASE}state-anchored-ai.svg`}
              alt="State-Anchored AI: Adopted badge"
              width={248}
              height={28}
              className="sa-badge"
            />
            <Block
              id="badge"
              title="Markdown"
              text={badge}
              copied={copied}
              onCopy={copy}
            />
          </section>
          <section id="verify" className="panel sa-sec">
            <h2>5. Verify audit evidence</h2>
            <p className="sa-hint">
              Free, no payment required. Status colors: green is
              Bitcoin-confirmed only; yellow is pending; red is tamper; grey is
              unavailable or missing and is never a pass.
            </p>
            <Verifier />
          </section>
          <section id="indep" className="panel sa-sec">
            <h2>6. Independence of verification</h2>
            <p>
              Public-header agreement is not full-node chain validation. For
              stronger independence, use the offline cookbook and your own
              mainnet Bitcoin Core node to check proofs against headers you
              validated yourself.
            </p>
          </section>
          <section
            id="licensing"
            className="panel sa-sec"
            data-testid="section-licensing"
          >
            <h2>7. Licensing, IP &amp; Enterprise Terms</h2>
            <p>
              <strong>Created &amp; Architected by Charles R. Strogish.</strong>
            </p>
            <p>Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.</p>
            <p>
              Covered first-party software is dual-licensed under GNU Affero
              General Public License version 3 (AGPLv3) or Enterprise Commercial
              terms.
            </p>
            <dl className="sa-dl">
              <div>
                <dt>Open-source · AGPLv3</dt>
                <dd>
                  AGPL permits commercial use when its conditions are met.
                  Preserve required notices and satisfy applicable
                  corresponding-source obligations, including section 13 for
                  modified versions that interact with users over a network.
                </dd>
              </div>
              <div>
                <dt>Enterprise · Commercial</dt>
                <dd>
                  For proprietary, closed-source enterprise swarm deployments or
                  multi-tenant hosting without the source disclosure required by
                  AGPL, a Commercial License from Charles R. Strogish is
                  required. Deployment rights, pricing, support and any SLA
                  require a separate written agreement with the maintainer.
                </dd>
              </div>
            </dl>
            <p>
              API payments do not purchase a commercial software license.
              Third-party code and separately licensed data retain their own
              terms; previously granted licenses are not revoked. These notices
              do not establish ownership of third-party contributions or certify
              regulatory compliance.
            </p>
            <p>
              <a
                href={`${BASE}LICENSE.md`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="link-license"
              >
                Read the complete AGPLv3 license and dual-licensing rider
              </a>{" "}
              ·{" "}
              <a
                href={`${BASE}SECURITY.md`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Vulnerability disclosure policy
              </a>
            </p>
            <p className="sa-hint">
              A commercial grant must be agreed in writing. Qualified legal
              review of ownership and enterprise terms is recommended.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
