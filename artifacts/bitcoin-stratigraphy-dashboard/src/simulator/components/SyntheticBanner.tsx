import { Info } from "lucide-react";

export function SyntheticBanner() {
  return (
    <div className="sim-banner" role="note" data-testid="banner-synthetic">
      <Info size={18} aria-hidden="true" />
      <div>
        <strong>Enterprise Sandbox Mode</strong>
        <p>
          The interactive visualizer below uses synthetic agent traces for
          risk-team evaluation. Unlike the Live REST Escrow above, this simulation
          does not require real Lightning Network micropayments or submit live
          Bitcoin timestamp commitments.
        </p>
      </div>
    </div>
  );
}
