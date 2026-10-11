import { Play } from "lucide-react";
import WhitepaperLink from "./whitepaper-link";
import "./site-footer.css";

export default function SiteFooter() {
  return (
    <footer className="site-footer" data-testid="global-footer">
      <div className="shell-inner">
        <div className="footer-note">
          <nav aria-label="Footer navigation">
            <WhitepaperLink />
            <a
              className="control-button"
              href={`${import.meta.env.BASE_URL}compliance`}
              data-testid="link-footer-compliance"
            >
              Enterprise Compliance
            </a>
          </nav>
          <span>
            <Play size={12} fill="currentColor" aria-hidden="true" /> SOURCE
            LINKS OPEN IN A NEW TAB
          </span>
          <span>
            ARCHITECTED BY CHARLES R. STROGISH | POWERED BY L402 MICROPAYMENTS,
            GROTH16 ZK-SNARK PROOFS &amp; NOSTR P2P MESH CONSENSUS.
          </span>
        </div>
      </div>
    </footer>
  );
}
