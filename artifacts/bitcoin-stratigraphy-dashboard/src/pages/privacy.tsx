// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import PrivacyContent from "./privacy-content";
import "./manifesto.css";
import "./privacy.css";

export default function PrivacyPage() {
  return <PrivacyContent base={import.meta.env.BASE_URL} />;
}
