// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import SecurityContent from "./security-content";
import "./manifesto.css";
import "./security.css";

export default function SecurityPage() {
  return <SecurityContent base={import.meta.env.BASE_URL} />;
}
