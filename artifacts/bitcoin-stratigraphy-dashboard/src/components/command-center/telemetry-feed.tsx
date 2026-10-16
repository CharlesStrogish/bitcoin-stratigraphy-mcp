// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type {
  GenesisTelemetry,
  AnchorTelemetry,
  ChainTelemetry,
} from "./telemetry-contracts";
import { telemetryFeedState } from "./telemetry-cache";
import { CopyTextButton } from "./copy-text-button";
import {
  formatSats,
  formatUsd,
  formatUtcDateTime,
  formatUtcTime,
} from "./format";
import {
  useEscrowLedgerStats,
  useEscrowTollQuote,
  useGenesisReceipt,
  useLightningVolume,
  useProvenanceAnchor,
  useProvenanceChain,
  useRecentSettlements,
  type SettlementRecord,
} from "./live-data";

type Accent = "gold" | "rust" | "teal" | "slate";
type Query<T> = UseQueryResult<T, unknown>;

const sitePath = (path: string) => `${import.meta.env.BASE_URL}${path}`;
const count = (value: number) => value.toLocaleString("en-US");

/** OpenTimestamps states as reported by the server, never upgraded client-side. */
const OTS_STATUS: Record<
  AnchorTelemetry["otsStatus"],
  { value: string; detail: string }
> = {
  not_anchored: {
    value: "Not anchored",
    detail: "No OpenTimestamps submission recorded",
  },
  pending_calendar: {
    value: "Calendar pending",
    detail: "Calendar-accepted; awaiting a Bitcoin block attestation",
  },
  bitcoin_block_attested: {
    value: "Bitcoin attested",
    detail: "Server reports a Bitcoin block attestation",
  },
};

function freshness(query: Query<unknown>) {
  return query.isError || !query.isFetchedAfterMount
    ? ` · last verified ${formatUtcDateTime(query.dataUpdatedAt)} · refreshing automatically`
    : "";
}

function Metric<T>({
  label,
  accent,
  query,
  render,
  testId,
}: {
  label: string;
  accent: Accent;
  query: Query<T>;
  render: (data: T) => { value: string; detail: string };
  testId: string;
}) {
  let value: ReactNode = "—";
  let detail: ReactNode = "Loading…";
  if (query.data !== undefined) {
    const rendered = render(query.data);
    value = rendered.value;
    detail = rendered.detail + freshness(query);
  } else if (query.isError) {
    value = "Connecting…";
    detail = "Awaiting a verified response · reconnecting automatically";
  }
  return (
    <div className={`cc-metric cc-accent-${accent}`} data-testid={testId}>
      <div className="cc-metric-label">{label}</div>
      <div className="cc-metric-value">{value}</div>
      <div className="cc-metric-detail">{detail}</div>
    </div>
  );
}

function RootRow<T>({
  label,
  scheme,
  query,
  root,
  meta,
  testId,
}: {
  label: string;
  scheme: string;
  query: Query<T>;
  root: (data: T) => string;
  meta: (data: T) => string;
  testId: string;
}) {
  const data = query.data;
  const value = data === undefined ? null : root(data);
  return (
    <div className="cc-root" data-testid={testId}>
      <div className="cc-root-head">
        <span className="cc-root-label">{label}</span>
        <span className="cc-scheme">{scheme}</span>
        {value && (
          <CopyTextButton
            variant="compact"
            text={value}
            label="Copy"
            context={label}
            description={`Copy the full ${label.toLowerCase()}`}
            testId={`${testId}-copy`}
          />
        )}
      </div>
      {data === undefined ? (
        <div className="cc-root-meta">
          {query.isError
            ? "Awaiting a verified root · reconnecting automatically"
            : "Loading verified root…"}
        </div>
      ) : (
        <>
          <code className="cc-root-value">{value}</code>
          <div className="cc-root-meta">
            {meta(data)}
            {freshness(query)}
          </div>
        </>
      )}
    </div>
  );
}

function escrowRootMeta(genesis: GenesisTelemetry) {
  const receipt = genesis.settle_response.article_12_receipt;
  const settlement = receipt.lightning_settlement;
  return [
    `Genesis escrow ${receipt.escrow_id}`,
    `tree size ${receipt.tree_size}, leaf ${receipt.leaf_index}`,
    settlement &&
      `Lightning-confirmed ${formatUtcDateTime(settlement.confirmed_at)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function strataRootMeta(
  chain: ChainTelemetry,
  anchor: AnchorTelemetry | undefined,
) {
  const parts = [`${count(chain.totalDepth)} verifiable telemetry strata`];
  if (anchor && anchor.otsStatus !== "not_anchored") {
    parts.push(
      anchor.merkleRoot === chain.merkleRoot
        ? "OpenTimestamps cryptographic state root"
        : "OpenTimestamps submission covers an earlier root",
    );
  }
  return parts.join(" · ");
}

function SettlementList({ query }: { query: Query<SettlementRecord[]> }) {
  let body: ReactNode;
  if (query.data === undefined) {
    body = query.isError ? (
      <p className="cc-empty" role="status">
        Connecting to verified settlements · reconnecting automatically.
      </p>
    ) : (
      <p className="cc-empty">Loading settlement records…</p>
    );
  } else if (!query.data.length) {
    body = (
      <p className="cc-empty">
        No verified Lightning settlements recorded yet.
      </p>
    );
  } else {
    body = (
      <ol className="cc-ledger-list">
        {query.data.map((record) => (
          <li className="cc-ledger-row" key={record.id}>
            <div className="cc-ledger-main">
              <time dateTime={record.timestamp}>
                {formatUtcDateTime(record.timestamp)}
              </time>
              <span className="cc-ledger-channel">{record.channel}</span>
              <span className="cc-ledger-kind">{record.requestKind}</span>
            </div>
            <div className="cc-ledger-side">
              {record.paymentReference && (
                <code title="Payment reference prefix">
                  {record.paymentReference}
                </code>
              )}
              <strong>{formatSats(record.satsReceived)}</strong>
            </div>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="cc-ledger" data-testid="list-recent-settlements">
      <div className="cc-subhead">
        Recent verified settlements <span>Latest 5 · sanitized</span>
      </div>
      {query.data !== undefined && freshness(query) && (
        <p className="cc-empty">Last verified records{freshness(query)}</p>
      )}
      {body}
    </div>
  );
}

export function TelemetryFeed() {
  const volume = useLightningVolume();
  const stats = useEscrowLedgerStats();
  const toll = useEscrowTollQuote();
  const anchor = useProvenanceAnchor();
  const chain = useProvenanceChain();
  const genesis = useGenesisReceipt();
  const settlements = useRecentSettlements();
  const feeds = [volume, stats, toll, anchor, chain, genesis, settlements];
  const status = telemetryFeedState(feeds);

  return (
    <section
      className="cc-module cc-telemetry"
      aria-labelledby="cc-telemetry-title"
      data-testid="module-telemetry"
    >
      <div className="cc-module-head">
        <div className="cc-module-intro">
          <div className="section-kicker">02 · Live telemetry</div>
          <h3 id="cc-telemetry-title">
            Live Cryptographic &amp; Merkle Telemetry Feed
          </h3>
          <p>
            Verified settlements, Merkle roots and OpenTimestamps status from
            this deployment&apos;s public API. Settlement figures refresh every
            five minutes.
          </p>
        </div>
        <div
          className={`cc-live${status.live ? "" : " cc-live-degraded"}`}
          data-testid="status-telemetry-live"
          role="status"
          aria-live="polite"
        >
          <span className="cc-live-dot" aria-hidden="true" />
          {status.label}
          {status.updatedAt > 0 && Number.isFinite(status.updatedAt) && (
            <span className="cc-live-time">
              {status.live ? "Updated" : "Oldest reading"}{" "}
              {formatUtcTime(status.updatedAt)}
            </span>
          )}
        </div>
      </div>

      <div className="cc-metrics">
        <Metric
          label="Mainnet sats accrued"
          accent="gold"
          query={volume}
          testId="metric-lightning-volume"
          render={(v) => ({
            value: formatSats(v.totalSats),
            detail: `Verified L402 ${count(v.l402Sats)} · NIP-90 ${count(v.nip90Sats)} · ${formatSats(v.last24hSats)} in 24 h`,
          })}
        />
        <Metric
          label="Escrow settle tolls"
          accent="rust"
          query={stats}
          testId="metric-escrow-tolls"
          render={(s) => ({
            value: formatSats(s.verified_toll_sats),
            detail: `${count(s.settled_contracts)} settled ${s.settled_contracts === 1 ? "contract" : "contracts"} · PostgreSQL escrow ledger`,
          })}
        />
        <Metric
          label="Live settle toll"
          accent="teal"
          query={toll}
          testId="metric-escrow-toll-quote"
          render={(t) => ({
            value: formatSats(t.toll_fee_sats),
            detail:
              t.source === "market" && t.btc_usd_price !== null
                ? `$${t.target_usd.toFixed(2)} target at BTC/USD ${formatUsd(t.btc_usd_price)}`
                : "Fallback quote · market price unavailable",
          })}
        />
        <Metric
          label="OpenTimestamps"
          accent="slate"
          query={anchor}
          testId="metric-ots-status"
          render={(a) => ({
            value: OTS_STATUS[a.otsStatus].value,
            detail: a.updatedAt
              ? `${OTS_STATUS[a.otsStatus].detail} · ${formatUtcDateTime(a.updatedAt)}`
              : OTS_STATUS[a.otsStatus].detail,
          })}
        />
      </div>

      <div className="cc-roots">
        <div className="cc-subhead">
          Merkle roots <span>Full values</span>
        </div>
        <RootRow
          label="Escrow execution root"
          scheme="RFC 6962"
          query={genesis}
          root={(g) => g.settle_response.merkle_root}
          meta={escrowRootMeta}
          testId="text-escrow-merkle-root"
        />
        <RootRow
          label="Strata provenance root"
          scheme="SHA-256 Merkle"
          query={chain}
          root={(c) => c.merkleRoot}
          meta={(c) => strataRootMeta(c, anchor.data)}
          testId="text-strata-merkle-root"
        />
        <div className="cc-links">
          <a
            className="cc-link"
            href={sitePath("api/v1/escrow/genesis-receipt")}
            target="_blank"
            rel="noreferrer"
            data-testid="link-genesis-receipt"
          >
            Genesis receipt JSON <ExternalLink size={12} aria-hidden="true" />
          </a>
          <a
            className="cc-link"
            href={sitePath("api/provenance/chain")}
            target="_blank"
            rel="noreferrer"
            data-testid="link-provenance-chain"
          >
            Provenance chain JSON <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      </div>

      <SettlementList query={settlements} />
    </section>
  );
}
