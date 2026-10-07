import { Building2 } from "lucide-react";

export default function EnterpriseLicenseLink() {
  return (
    <a
      className="control-button"
      href={`${import.meta.env.BASE_URL}enterprise`}
      data-testid="link-enterprise"
    >
      <Building2 size={14} aria-hidden="true" /> Enterprise License
    </a>
  );
}
