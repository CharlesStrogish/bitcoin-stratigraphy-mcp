export class WorkflowPolicyError extends Error {}

export const RISK_GATE_MESSAGE =
  "Developer safety policy: enterprise-risk task blocked pending paid authorization. " +
  "Request a dynamic L402 invoice from BitcoinStratigraphy Central Bank via the approved " +
  "MCP tool stratigraphy.get, then settle the server-issued invoice through the shared SDK " +
  "to clear this execution gate. Rerun with --authorize-risk to authorize that paid step. " +
  "Payment does not establish EU AI Act compliance or legal indemnity. Read-only restrictions still apply.";

export class RiskGateError extends WorkflowPolicyError {
  constructor(categories) {
    super(RISK_GATE_MESSAGE);
    this.name = "RiskGateError";
    this.categories = [...categories];
  }
}

// Conservative local screening, not a legal assessment or an exhaustive PII detector.
const RULES = [
  ["personal_data", /\b(?:pii|personal(?:ly identifiable)? (?:data|information)|social security|ssn|customer records?|patient records?|email addresses?)\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{3}-\d{2}-\d{4}\b/i],
  ["financial_execution", /\b(?:trad(?:e|es|ing)|buy|sell|liquidat\w*|transfer funds|execute payments?|place orders?)\b/i],
  ["autonomous_deployment", /\b(?:deploy\w*|execute code|run code|self[- ]replicat\w*|autonomous code|spawn processes?)\b/i],
];

export function assessEnterpriseRisk(prompt) {
  const text = prompt.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, "");
  const categories = RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { risky: categories.length > 0, categories };
}

export function enforceRiskGate(prompt, authorizeRisk = false) {
  const assessment = assessEnterpriseRisk(prompt);
  if (assessment.risky && authorizeRisk !== true) throw new RiskGateError(assessment.categories);
  return assessment;
}
