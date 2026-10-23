import { Play, ShieldCheck } from "lucide-react";
import WhitepaperLink from "./whitepaper-link";
import Article12VerifierLink from "./article12-verifier-link";
import "./site-footer.css";

export default function SiteFooter() {
  return (
    <footer className="site-footer" data-testid="global-footer">
      <div className="shell-inner">
        <div className="footer-note">
          <nav aria-label="Footer navigation">
            <Article12VerifierLink placement="footer" />
            <WhitepaperLink />
            <a
              className="control-button"
              href={`${import.meta.env.BASE_URL}compliance`}
              data-testid="link-footer-compliance"
            >
              <ShieldCheck size={14} aria-hidden="true" />
              Enterprise Compliance
            </a>
          </nav>
          <span>
            <Play size={12} fill="currentColor" aria-hidden="true" /> SOURCE
            LINKS OPEN IN A NEW TAB
          </span>
          <span>
            BITCOIN STRATIGRAPHY DATA ENGINE © 2026 | ARCHITECTED BY CHARLES R.
            STROGISH | ENTERPRISE MCP SERVER POWERED BY L402 MICROPAYMENTS, RFC
            6962 MERKLE PROOFS &amp; OPENTIMESTAMPS STATE ANCHORING.
          </span>
        </div>
      </div>
    </footer>
  );
}
