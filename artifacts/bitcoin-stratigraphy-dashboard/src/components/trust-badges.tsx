import type { ReactNode } from "react";

const SMITHERY_URL =
  "https://smithery.ai/servers/crstrogish/bitcoin-stratigraphy-mcp";
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
          href={SMITHERY_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="link-smithery-listing"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 126 20"
            width="126"
            height="20"
            role="img"
            aria-label="Smithery score: 100 out of 100"
            data-testid="badge-smithery"
          >
            <rect width="126" height="20" rx="4" fill="#18181b" />
            <path
              d="M79 0h43a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H79z"
              fill="#16834a"
            />
            <text
              x="9"
              y="13.7"
              fill="#fff"
              fontFamily="Arial, sans-serif"
              fontSize="11"
              fontWeight="700"
            >
              Smithery
            </text>
            <text
              x="85"
              y="13.4"
              fill="#fff"
              fontFamily="Arial, sans-serif"
              fontSize="10"
              fontWeight="700"
            >
              100/100
            </text>
          </svg>
        </a>
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
