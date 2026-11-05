// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import ManifestoContent from "./manifesto-content";
import "./manifesto.css";

export default function ManifestoPage() {
  return <ManifestoContent base={import.meta.env.BASE_URL} />;
}
