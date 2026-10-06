import { ShieldAlert } from "lucide-react";

export function SyntheticBanner() {
  return (
    <div className="sim-banner" role="note" data-testid="banner-synthetic">
      <ShieldAlert size={18} aria-hidden="true" />
      <div>
        <strong>
          SYNTHETIC SIMULATION. Runs entirely in this browser tab.
        </strong>
        <p>
          No payment is made. No calendar submission happens. No Bitcoin
          confirmation exists. Hashing and Merkle membership are real SHA-256;
          the notarization step and its receipt are illustrative objects only.
        </p>
      </div>
    </div>
  );
}
