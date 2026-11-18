import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const section = (heading) => readme.split(`## ${heading}\n`)[1]?.split("\n## ")[0];

test("enterprise README preserves value propositions and links the audit report and recovery guide", () => {
  const capabilities = section("Enterprise Architecture & Capabilities");
  assert.ok(capabilities);
  for (const label of [
    "Zero-Touch Enterprise Procurement", "Zero-Trust Security & Compliance",
    "The 21% Algorithmic Handshake", "Eradicate Hallucinations", "Free Tool Discovery",
  ]) assert.ok(capabilities.includes(`**${label}:**`), label);
  assert.match(capabilities, /published security audit.*reports/);
  assert.match(capabilities, /1,064 rigorous regression and penetration tests/);
  assert.match(capabilities, /0 critical, high, medium, or low vulnerabilities detected/);
  assert.match(capabilities, /not a guarantee against future vulnerabilities/);
  for (const [label, route] of [
    ["Enterprise Troubleshooting & Disaster Recovery", "/developers/enterprise-troubleshooting"],
    ["Zero-Trust Security Audit (1,064 Tests)", "/security"],
  ]) assert.ok(readme.includes(`[${label}](https://bitcoinstratigraphy.com${route})`));
});

test("hosted MCP quickstart precedes the workspace wrapper without promising unpaid or unreleased access", () => {
  const install = section("1-Line Installation");
  assert.ok(install);
  assert.ok(install.indexOf("npx add-mcp 'https://bitcoinstratigraphy.com/mcp'") <
    install.indexOf("npm install @bitcoinstratigraphy/agent-yield"));
  assert.match(install, /live now for immediate Streamable HTTP/);
  assert.match(install, /workspace-built/);
  assert.match(install, /separate\s+npm registry release/);
  assert.match(install, /paid calls still require authorized\s+L402 settlement/);
  assert.match(install, /serverPublicKey: independentlyTrustedServerPublicKeyPem/);
});

test("yield math and tool capacity retain their settlement and opt-in boundaries", () => {
  for (const content of [
    section("Enterprise Architecture & Capabilities"),
    section("Architecture Overview"),
  ]) {
    assert.match(content, /21% Agent Yield/);
    assert.match(content, /15% upstream origin allocation \+\s*6% verifying caller allocation/);
  }
  assert.match(readme, /14 paid tools and 2 free sandbox tools/);
  assert.match(readme, /Add `payment\.get_escrow` for 17 tools, then the 2 opt-in `clearing\.\*` tools/);
  assert.match(readme, /accounting\s+remains ledger-only, with no automatic disbursement/);
  assert.match(readme, /Integer-msat\s+rounding preserves the original pool exactly/);
  for (const heading of [
    "Enterprise Architecture", "Licensing, IP & Enterprise Terms",
    "Limitation of Liability & Hold Harmless", "Architecture Overview",
    "Key Capabilities", "Tool Directory", "Public Auto-Discovery",
  ]) assert.ok(section(heading), heading);
});
