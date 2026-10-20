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
        ? <span>NETWORK STATUS UNAVAILABLE{stats
          ? ` • LAST KNOWN: ${stats.total_settled_sats.toLocaleString("en-US")} SATS SETTLED • ${stats.total_contracts.toLocaleString("en-US")} CONTRACTS (STALE)`
          : " • RETRYING AUTOMATICALLY"}</span>
        : stats
          ? <span>LIVE NETWORK • {stats.total_settled_sats.toLocaleString("en-US")} SATS SETTLED
            {" • "}{stats.total_contracts.toLocaleString("en-US")} {stats.total_contracts === 1 ? "CONTRACT" : "CONTRACTS"}
            {" • LATEST ROOT: "}<span title={stats.latest_merkle_root
              ? `Latest execution leaf hash: ${stats.latest_merkle_root}`
              : "No settlements recorded"}>{stats.latest_merkle_root
                ? `${stats.latest_merkle_root.slice(0, 8)}…` : "NONE YET"}</span></span>
          : <span>CONNECTING TO LIVE NETWORK…</span>}
    </div>
  );
}
