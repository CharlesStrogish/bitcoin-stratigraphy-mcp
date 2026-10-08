import { BookOpen } from "lucide-react";

export default function WhitepaperLink() {
  return (
    <a
      className="control-button"
      href={`${import.meta.env.BASE_URL}whitepaper`}
      data-testid="link-whitepaper"
    >
      <BookOpen size={14} aria-hidden="true" /> Whitepaper
    </a>
  );
}
