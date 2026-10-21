import { MERKLE_EXAMPLE } from "./whitepaper-example";

const BASE = import.meta.env.BASE_URL;

export const WHITEPAPER_SECTIONS = [
  { id: "compliance", title: "Article 12 mandate" },
  { id: "merkle", title: "Merkle recorders & OpenTimestamps" },
  { id: "arbitration", title: "Multi-vendor arbitration" },
  { id: "circuit-breakers", title: "L402 circuit breakers" },
  { id: "deployment", title: "Licensing & air-gapped deployment" },
];

const MERKLE_FORMULAS = `H_leaf(d) = SHA-256(0x00 || d)

MTH([]) = SHA-256(empty byte string)
MTH([d]) = H_leaf(d)
MTH(D[0:n]) = SHA-256(
  0x01 || MTH(D[0:k]) || MTH(D[k:n])
)

k = largest power of two strictly less than n, for n > 1
|| = byte concatenation`;

export default function WhitepaperContent() {
  return (
    <>
      <section className="wp-section" id="abstract">
        <h2>Abstract</h2>
        <p>
          Autonomous AI systems need evidence that survives the incident they
          record. Mutable logs can be edited, deleted, or replaced by the same
          infrastructure whose behavior is under investigation, undermining the
          traceability and post-hoc reconstruction needed to support EU AI Act
          Article 12. A timestamp column alone does not expose that rewriting.
        </p>
        <p>
          State-Anchored AI combines automatic event capture, RFC 6962-style
          ordered Merkle flight recorders, and OpenTimestamps commitments to
          Bitcoin. The resulting evidence binds selected records to retained
          batch roots and, after independent confirmation, to public Bitcoin
          commitments. This architecture supports cross-vendor investigations,
          bounded agent spending, and private enterprise deployments without
          publishing proprietary model weights or entire execution logs.
        </p>
        <aside className="wp-note">
          <strong>Compliance boundary.</strong> Article 12 requires relevant
          high-risk AI systems to technically allow automatic event logging over
          their lifetime. It does not prescribe Merkle trees or Bitcoin.
          Cryptographic integrity supports compliance evidence; it does not
          certify compliance, completeness, truthful inputs, or legal liability.
          Applicability and additional obligations require qualified legal
          review.
        </aside>
      </section>

      <section className="wp-section" id="compliance">
        <h2>1. The Article 12 Compliance Mandate</h2>
        <h3>Continuous Automation</h3>
        <p>
          Record events at the execution boundary, not only when an operator
          starts an audit. Capture the agent identity claim (cryptographically
          authenticated via NIP-98 Schnorr signatures), run and sequence
          identifiers, relevant input/output context or digests, tool
          invocation, policy version, result, and producer-declared UTC time.
          Logging failures must be observable, with an explicit deployment
          policy for pausing high-risk operations rather than silently
          discarding evidence.
        </p>
        <h3>Post-Hoc Reconstruction</h3>
        <p>
          Correlated run identifiers and causal references let an auditor follow
          an instruction through planning, delegation, tool execution, and
          settlement. Preserve the original journals, canonical encodings,
          verification proofs, and relevant system versions under controlled
          access. A root digest is an integrity reference, not an archive:
          reconstruction still requires the underlying authorized records.
        </p>
        <h3>Tamper-Evident Chain of Custody</h3>
        <p>
          Seal checkpoints with recorder keys enrolled independently by the
          enterprise, and retain expected-record manifests outside the logging
          host. Compare records with those retained commitments to detect
          substitution, changed bytes, or missing expected data. A chain that
          can be replaced in its entirety on one compromised host is not
          independent evidence. Neither a Merkle root nor an anchor can reveal
          an event that was never recorded; completeness needs separate
          controls.
        </p>
      </section>

      <section className="wp-section" id="merkle">
        <h2>2. RFC 6962 Merkle Flight Recorders &amp; OpenTimestamps</h2>
        <h3>Domain-Separated, Ordered Commitments</h3>
        <p>
          Adapt the Merkle construction in RFC 6962 Section 2.1 to an ordered
          sequence of event encodings. Leaves are ordered by recorder
          acceptance, not by an untrusted wall-clock claim. Domain separation
          distinguishes a leaf preimage from an internal node, preventing the
          two encodings from being confused. The tree is unpadded: do not
          duplicate the last leaf to fill an incomplete level.
        </p>
        <figure className="wp-formula">
          <figcaption>RFC 6962 / SHA-256 tree construction</figcaption>
          <pre tabIndex={0} aria-label="Merkle leaf and tree hash formulas">
            <code>{MERKLE_FORMULAS}</code>
          </pre>
        </figure>
        <p>
          The prefixes are single bytes, 0x00 and 0x01; internal nodes
          concatenate raw 32-byte child digests, not their hexadecimal text. In
          the enterprise recorder, each leaf preimage is a versioned, salted
          trace envelope: canonical JSON with sorted keys, compact UTF-8
          encoding, and no NaN. Reject duplicate or coerced keys. Retain the
          original evidence rather than assuming a later parse-and-reserialize
          operation preserves its signed bytes.
        </p>
        <h3>Merkle Inclusion Proof Payload</h3>
        <p>
          An inclusion proof supplies the selected leaf position, tree size, and
          ordered sibling hashes. Recompute the leaf and fold the path using the
          index and tree shape; reject malformed, short, extra, or out-of-range
          paths. For the two-leaf example below, leaf 0 is the left child, so
          its root is SHA-256(0x01 || leaf_hash || path[0]).
        </p>
        <figure className="wp-code">
          <figcaption>
            JSON / Reproducible example — not a live API response or Bitcoin
            receipt
          </figcaption>
          <pre tabIndex={0} aria-label="Sample Merkle inclusion proof JSON">
            <code>{JSON.stringify(MERKLE_EXAMPLE, null, 2)}</code>
          </pre>
        </figure>
        <p>
          Rebuild this leaf from the displayed trace and salt using the envelope
          keys <code>schema_version</code> (value <code>saai-swarm-leaf/1</code>
          ), <code>salt</code>, and <code>trace</code>. The displayed hashes are
          mathematically consistent. Its fixed salt is for reproducibility only:
          production leaves need fresh, private, unpredictable 32-byte salts,
          disclosing only the selected trace&apos;s salt. A Merkle path exposes
          position, tree size, and sibling commitments; it is selective
          disclosure, not a zero-knowledge proof.
        </p>
        <h3>From Local Membership to Bitcoin Evidence</h3>
        <ol>
          <li>
            <strong>Commit:</strong> close a bounded batch, retain its records,
            and seal the root and tree size with the enrolled recorder key.
          </li>
          <li>
            <strong>Submit:</strong> send the root commitment to OpenTimestamps
            through the authorized network path; retain the detached proof.
            Calendar acceptance is provisional, not Bitcoin confirmation.
          </li>
          <li>
            <strong>Upgrade:</strong> obtain the completed Bitcoin attestation
            when available, preserving the original receipt and any later
            upgrade as distinct evidence.
          </li>
          <li>
            <strong>Verify:</strong> bind the proof to the exact committed root
            and check Bitcoin inclusion against independently validated mainnet
            evidence, preferably the auditor&apos;s own Bitcoin Core node.
          </li>
        </ol>
        <p>
          Local membership, recorder authority, and Bitcoin inclusion are
          separate findings. Public-header corroboration is weaker than an
          auditor-controlled validated chain. A confirmed anchor establishes a
          commitment&apos;s existence by the referenced block, not an exact
          legal UTC execution time or the truth of the logged event. An
          inclusion proof also does not prove append-only history: consistency
          proofs can check prefix preservation between growing trees, while
          retained checkpoints and manifests protect bounded-batch continuity.
        </p>
      </section>

      <section className="wp-section" id="arbitration">
        <h2>3. Multi-Vendor Arbitration Protocol</h2>
        <p>
          A swarm may combine a planner from one vendor, a policy agent from
          another, and an execution tool from a third. When a transaction fails,
          inconsistent vendor logs create competing narratives. A shared
          evidence protocol preserves the causal hand-offs and commits each
          party&apos;s recorded actions before the dispute.
        </p>
        <ol>
          <li>
            Enroll vendor keys and their corporate authority through an agreed
            trust process; a self-declared public key is not corporate identity.
          </li>
          <li>
            Correlate requests, responses, policy decisions, and execution
            results with shared run identifiers and signed hand-off
            acknowledgments.
          </li>
          <li>
            Disclose relevant records with Merkle paths, recorder seals, and
            anchoring evidence under contractual confidentiality controls.
          </li>
          <li>
            Independently verify the commitments, compare the causal sequence
            with agreed duties, and preserve missing or unverifiable evidence as
            an explicit finding.
          </li>
        </ol>
        <p>
          This establishes which recorded action is attributable to an enrolled
          key and whether disclosed records match retained commitments. It
          supports identifying an agent&apos;s mistake, but does not
          automatically establish fault, truthful sensor inputs, undisclosed
          reasoning, or legal liability. The parties or appointed arbitrator
          make that determination.
        </p>
      </section>

      <section className="wp-section" id="circuit-breakers">
        <h2>4. L402 Micropayment Circuit Breakers</h2>
        <p>
          L402 combines an HTTP payment challenge, a scoped macaroon, and a
          Lightning payment preimage. Access can be restricted by expiry,
          permitted operations, and metered request allowances. An autonomous
          client must not interpret every new challenge as unconditional
          authority to spend: a runaway agent can exhaust a wallet even when
          each invoice is valid.
        </p>
        <p>
          Apply per-invoice ceilings, cumulative run budgets in satoshis, time
          windows, and permitted-tool policies at the wallet or payment
          coordinator. Request-count caveats alone are not a wallet-wide
          monetary cap. Bind approval to the exact quote, invoice hash, scope,
          and issued price; reserve budget atomically across parallel workers
          before payment.
        </p>
        <figure className="wp-formula">
          <figcaption>Admission rule / shared spending ledger</figcaption>
          <pre tabIndex={0} aria-label="Agent spending budget admission rule">
            <code>{`settled_spend + reserved_spend + new_quote <= run_budget
new_quote <= per_invoice_ceiling`}</code>
          </pre>
        </figure>
        <p>
          Reject further payments when a cap is reached or authoritative budget
          state is unavailable. Descendant macaroons must consume every
          inherited request allowance, so delegation cannot reset a
          parent&apos;s limit. Deduplicate invoice payments and bind preimages
          to their challenge hashes. An uncertain payment outcome must remain
          reserved until reconciled; retries must not purchase the same
          entitlement twice.
        </p>
        <p>
          For cyber-insurance underwriting, retain the approved budget,
          reservation decisions, settlement outcomes, cap-triggered stops, and
          exception approvals alongside the flight recorder. This gives an
          underwriter evidence of loss-limiting controls and their operation. It
          does not guarantee coverage, premium reductions, or caps on payments
          made outside the governed wallet and coordinator.
        </p>
      </section>

      <section className="wp-section" id="deployment">
        <h2>5. Enterprise Licensing &amp; Air-Gapped Deployment</h2>
        <p>
          Covered first-party engine software is deployed as a Stateless
          Enterprise MCP Server (2026-07-28 specification) secured by Ed25519
          Cryptographically Signed Tool Integrity. It has an AGPLv3 open-source
          option.
          A separately executed Enterprise Commercial License grants an
          exemption from the AGPL obligations for the software and deployment
          covered by that agreement. Enterprises can run the licensed engine
          behind their own firewalls without AGPL-based disclosure of
          proprietary AI code or model weights within the agreed commercial
          scope.
        </p>
        <p>
          AGPL does not automatically require all independent applications or
          model weights to be open-sourced. Third-party components and
          separately licensed data retain their own terms. API micropayments do
          not purchase a commercial software license; deployment rights
          and support require a written agreement.
        </p>
        <p>
          Local event capture, Merkle construction, and proof checking can
          operate inside an isolated environment. Public Bitcoin anchoring still
          needs an approved export/import process: export commitment digests
          through a governed gateway, retain and import the resulting proofs,
          and verify against independently trusted chain evidence. An air-gapped
          recorder does not directly reach public calendars or mainnet. Keep
          proprietary plaintext and undisclosed salts inside the enclave; even
          digest exports require an explicit information-security policy.
        </p>
        <p>
          Enterprise pricing is customized to swarm size and deployment needs.
          The agreed commercial license is settled in one upfront Bitcoin
          transaction, paid in full at execution of the agreement. That payment
          is distinct from public API Lightning micropayments or any separately
          agreed notary-service charges. Scope, acceptance, and service
          commitments are contractual terms, not promises implied by a timestamp
          receipt.
        </p>
        <p>
          See the <a href={`${BASE}standard`}>proposed SA-AI specification</a>{" "}
          for the requirements and verification boundaries, and the{" "}
          <a href={`${BASE}LICENSE.md`}>
            complete license and dual-licensing rider
          </a>{" "}
          for the applicable software terms.
        </p>
      </section>

      <section className="wp-section" id="references">
        <h2>Technical References</h2>
        <ul>
          <li>
            <a href="https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng">
              Regulation (EU) 2024/1689, Article 12 — Record-keeping
            </a>
          </li>
          <li>
            <a href="https://www.rfc-editor.org/rfc/rfc6962#section-2.1">
              RFC 6962, Section 2.1 — Merkle Hash Trees
            </a>
          </li>
          <li>
            <a href="https://opentimestamps.org/">
              OpenTimestamps — independently verifiable timestamping
            </a>
          </li>
          <li>
            <a href="https://www.gnu.org/licenses/agpl-3.0.html">
              GNU Affero General Public License version 3
            </a>
          </li>
        </ul>
      </section>
    </>
  );
}
