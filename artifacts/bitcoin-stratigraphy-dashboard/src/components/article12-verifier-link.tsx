import { ShieldCheck } from "lucide-react";
import "./article12-verifier-link.css";

export default function Article12VerifierLink({
  placement = "navigation",
}: {
  placement?: "navigation" | "footer";
}) {
  return (
    <a
      className="control-button article12-verifier-link"
      href={`${import.meta.env.BASE_URL}static/verify.html`}
      data-testid={`link-${placement}-article12-verifier`}
    >
      <ShieldCheck size={14} aria-hidden="true" />
      <span>Article 12 Verifier (Zero-Trust)</span>
    </a>
  );
}
