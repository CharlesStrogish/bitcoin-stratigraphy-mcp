import type { ReactNode } from "react";

const GLAMA_URL =
  "https://glama.ai/mcp/connectors/app.replit.bitcoin-stratigraphy-dashboard--charlesstrogish/bitcoin-stratigraphy";
const MCPSERVERS_URL =
  "https://mcpservers.org/servers/charlesstrogish/bitcoin-stratigraphy-mcp";

/** Directory links and score badges; listing status is not a verification seal. */
export function TrustBadges({ extra }: { extra?: ReactNode }) {
  return (
    <aside
      className="trust-badges"
      aria-label="Official trust badges"
      data-testid="trust-badges"
    >
      <span className="trust-label">Official trust badges</span>
      <div className="trust-row">
        <a
          href={GLAMA_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="link-glama-listing"
        >
          <img
            src={`${GLAMA_URL}/badges/score.svg`}
            alt="Glama Score Badge"
            loading="lazy"
          />
        </a>
        <a
          href={MCPSERVERS_URL}
          className="trust-listing-chip"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="link-mcpservers-listing"
        >
          mcpservers.org · Official listing
        </a>
        {extra}
      </div>
    </aside>
  );
}
