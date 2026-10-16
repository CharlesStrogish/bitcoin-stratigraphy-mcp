// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { ShieldCheck } from "lucide-react";

export default function ComplianceGuideLink() {
  return (
    <a
      className="control-button"
      href={`${import.meta.env.BASE_URL}compliance`}
      data-testid="link-compliance-guide"
    >
      <ShieldCheck size={14} aria-hidden="true" /> EU AI Act Article 12
      Compliance Guide
    </a>
  );
}
