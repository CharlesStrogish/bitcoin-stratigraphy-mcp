import type { EscrowLedgerStats } from "@workspace/api-client-react";

export function EscrowNetworkTicker({ stats, unavailable }: {
  stats: EscrowLedgerStats | null;
  unavailable: boolean;
}) {
  return (
    <div className="et-network" data-live={Boolean(stats && !unavailable)}
      data-testid="escrow-network-ticker" role="status">
      <span className="et-network-dot" aria-hidden="true" />
      {unavailable
        ? <span>NETWORK STATUS UNAVAILABLE • RETRYING AUTOMATICALLY</span>
        : stats
          ? <span>LIVE NETWORK • L402 SETTLEMENT ENGINE ACTIVE
            {" • LATEST ROOT: "}<span title={stats.latest_merkle_root
              ? `Latest execution leaf hash: ${stats.latest_merkle_root}`
              : "No settlements recorded"}>{stats.latest_merkle_root
                ? `${stats.latest_merkle_root.slice(0, 8)}…` : "NONE YET"}</span></span>
          : <span>CONNECTING TO LIVE NETWORK…</span>}
    </div>
  );
}
