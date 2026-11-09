import { createHash } from "node:crypto";

export const scannerPromptHash = (prompt: string) =>
  createHash("sha256").update(prompt, "utf8").digest("hex");

const rules = [
  {
    category: "pii_biometric" as const,
    label: "PII / Biometric processing",
    pattern: /\b(pii|personal(?:ly identifiable)? (?:data|information)|biometrics?|facial recognition|face recognition|fingerprints?|voiceprints?|social security|ssn|passport|patient records?|medical records?|email addresses?|phone numbers?|credit cards?|date of birth)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}-\d{2}-\d{4}\b/i,
    rationale: "Potential personal-data or biometric processing. Review purpose, lawful basis, access controls and traceable execution logs.",
  },
  {
    category: "financial_execution" as const,
    label: "Financial / Trading execution",
    pattern: /\b(execute.{0,35}(?:trades?|orders?|transactions?)|(?:buy|sell).{0,35}(?:stocks?|bitcoin|crypto|securities)|trading|trade execution|transfer funds|financial transactions?|portfolio rebalanc(?:e|ing)|place.{0,20}orders?)\b/i,
    rationale: "Potential financial execution. Record authorization, limits, human oversight, inputs and execution outcomes.",
  },
  {
    category: "autonomous_deployment" as const,
    label: "Autonomous code deployment",
    pattern: /\b((?:autonomous|automatically|without (?:human|manual) (?:review|approval)).{0,90}(?:deploy(?:ment|ing)?|release|push|production)|(?:deploy(?:ment|ing)?|release|push).{0,90}(?:autonomous|automatically|without (?:human|manual) (?:review|approval))|deploy.{0,30}(?:production|code)|ci\/cd|self[- ]deploy)\b/i,
    rationale: "Potential autonomous software deployment. Preserve approvals, versioned changes, rollback evidence and immutable execution history.",
  },
];

/** Keyword signals are deliberately conservative, not a legal classification. */
export function analyzeScannerPrompt(prompt: string) {
  const searchable = prompt.normalize("NFKC").replace(/\s+/g, " ");
  const flagged_categories = rules
    .filter((rule) => rule.pattern.test(searchable))
    .map(({ category, label, rationale }) => ({
      category, label, risk_level: "High" as const, rationale,
    }));
  const report = {
    schema: "article12-heuristic/v1" as const,
    overall_risk_level: flagged_categories.length ? "High" as const
      : /\b(agents?|automated|autonomous|decisions?|customers?|employees?)\b/i.test(searchable)
        ? "Medium" as const : "Low" as const,
    flagged_categories,
    prompt_sha256: scannerPromptHash(prompt),
    receipt_type: "simulated_zk_receipt" as const,
    limitations: "Keyword-based risk screening, not a legal compliance determination. Context, negation, obfuscation and languages may produce false positives or negatives. Low means no configured high-risk keyword matched, not proof of safety. Compliance Hash is a SHA-256 audit commitment simulating a receipt; it is not a ZK proof, signed attestation or Bitcoin timestamp. Prompts and reports are not retained by this service.",
  };
  // Deterministic, domain-separated commitment to the complete report.
  return {
    ...report,
    compliance_hash: scannerPromptHash(`bitcoinstratigraphy/scanner/v1\n${JSON.stringify(report)}`),
  };
}
