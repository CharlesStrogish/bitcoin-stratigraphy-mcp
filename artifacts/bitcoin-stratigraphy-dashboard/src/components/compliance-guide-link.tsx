import { ShieldCheck } from "lucide-react";

export default function ComplianceGuideLink() {
  return (
    <a
      className="control-button"
      href={`${import.meta.env.BASE_URL}compliance`}
      data-testid="link-compliance-guide"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, margin: "16px 0 10px", textDecoration: "none" }}
    >
      <ShieldCheck size={14} aria-hidden="true" /> EU AI Act Article 12 Compliance Guide
    </a>
  );
}
