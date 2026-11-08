// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import markdown from "../../../../circuits/MPC_CEREMONY.md?raw";
import CeremonyContent from "./ceremony-content";
import "./manifesto.css";
import "./ceremony.css";

export default function CeremonyPage() {
  return <CeremonyContent markdown={markdown} base={import.meta.env.BASE_URL} />;
}
