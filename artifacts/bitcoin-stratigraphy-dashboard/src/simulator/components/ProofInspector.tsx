import { CheckCircle2, Download, XCircle } from "lucide-react";
import type { InclusionProof, LeafRecord } from "../engine/simulation.ts";
import { CopyJsonButton } from "./CopyJsonButton";

export type InspectState = {
  status: "idle" | "working" | "valid" | "invalid" | "error";
  proof?: InclusionProof;
  root?: string;
  message?: string;
};

export function ProofInspector({
  record,
  state,
  onDownload,
}: {
  record: LeafRecord | null;
  state: InspectState;
  onDownload: () => void;
}) {
  const proofJson =
    record && state.proof ? JSON.stringify(state.proof, null, 2) : null;
  return (
    <section
      className="panel sim-panel"
      aria-labelledby="sim-inspector-h"
      data-testid="panel-inspector"
    >
      <div className="panel-heading">
        <div>
          <div className="section-kicker">Selective Disclosure</div>
          <h2 id="sim-inspector-h">Proof inspector</h2>
        </div>
        <CopyJsonButton text={proofJson} testId="button-copy-proof-json" />
      </div>
      <div className="sim-pad">
        <p className="sim-note">
          Selective Disclosure here is a salted Merkle audit path. It is{" "}
          <b>not zero-knowledge</b>: the exported file reveals the one chosen
          trace, its salt, sibling hashes, tree size and leaf position. Every
          other trace's plaintext and salt stay out of the file.
        </p>
        {!record ? (
          <div className="sim-empty">
            Select a captured thought to build and verify its inclusion path.
          </div>
        ) : (
          <>
            <dl className="sim-kv">
              <div>
                <dt>Leaf index</dt>
                <dd>{record.index}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>
                  {record.trace.agent_id} ({record.trace.role})
                </dd>
              </div>
              <div>
                <dt>Tool</dt>
                <dd>{record.trace.tool}</dd>
              </div>
              <div>
                <dt>Tokens in / out</dt>
                <dd>
                  {record.trace.tokens_in} / {record.trace.tokens_out}
                </dd>
              </div>
            </dl>
            <blockquote className="sim-thought">
              {record.trace.thought}
            </blockquote>
            <div
              className="sim-verdict"
              role="status"
              aria-live="polite"
              data-testid="status-membership"
            >
              {state.status === "working" && (
                <span>Computing audit path...</span>
              )}
              {state.status === "valid" && (
                <span className="sim-ok">
                  <CheckCircle2 size={16} aria-hidden="true" /> Membership
                  verified (real SHA-256) against root of{" "}
                  {state.proof?.tree_size} leaves
                </span>
              )}
              {state.status === "invalid" && (
                <span className="sim-bad">
                  <XCircle size={16} aria-hidden="true" /> Path does not
                  reproduce the root
                </span>
              )}
              {state.status === "error" && (
                <span className="sim-bad">{state.message}</span>
              )}
            </div>
            {state.proof && (
              <details className="sim-details">
                <summary>
                  Merkle proof object ({state.proof.path.length} siblings)
                </summary>
                <pre tabIndex={0}>{proofJson}</pre>
              </details>
            )}
            <button
              type="button"
              className="control-button"
              onClick={onDownload}
              disabled={state.status !== "valid"}
              data-testid="button-download-proof"
            >
              <Download size={14} aria-hidden="true" /> Download single-trace
              proof
            </button>
          </>
        )}
      </div>
    </section>
  );
}
