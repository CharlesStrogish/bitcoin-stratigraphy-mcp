import { ShieldAlert } from "lucide-react";

export function SyntheticBanner() {
  return (
    <div className="sim-banner" role="note" data-testid="banner-synthetic">
      <ShieldAlert size={18} aria-hidden="true" />
      <div>
        <strong>
          Live REST Escrow · real Lightning Network micropayments
        </strong>
        <p>
          The escrow terminal below executes real payments via L402 and Nostr
          Wallet Connect (NWC). Enterprise Interactive Preview is a client-only
          visualizer: its example traces and illustrative receipts do not initiate
          payments or submit Bitcoin timestamp commitments.
        </p>
      </div>
    </div>
  );
}
