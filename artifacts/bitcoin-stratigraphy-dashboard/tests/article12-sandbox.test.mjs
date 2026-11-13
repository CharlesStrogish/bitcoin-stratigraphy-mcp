import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const source = read("components/article12-sandbox.tsx");
const css = read("components/article12-sandbox.css");
const app = read("App.tsx");

test("the homepage sandbox preserves the requested log, audit, warning and pipeline copy", () => {
  for (const copy of [
    "Article 12 Vulnerability Scanner (Interactive Sandbox)",
    "Paste Sample AI Execution Log (or use default)",
    "Run Compliance Audit",
    "NON-COMPLIANT: Log is mutable and unanchored. Lacks cryptographic timestamp. Fails EU AI Act Article 12 traceback mandates. Liability risk detected.",
    "Secure via Bitcoin Stratigraphy",
    "[x] Generating SHA-256 Digest...",
    "[x] Constructing RFC 6962 Merkle Flight Record...",
    "[x] Anchoring to OpenTimestamps...",
    "[x] Zero-Knowledge Indemnity Receipt Forged.",
    "✓ L402 ZK-Proof Generated. Simulation Complete.",
    "Deploy to Production: Secure $500 Enterprise API Block",
  ]) assert.ok(source.includes(copy), `required copy: ${copy}`);
  assert.match(source, /agent: "gpt-4", action: "execute_trade", timestamp: "2026-11-08"/);
});

test("the demonstration keeps log data local and labels its outputs as simulated", () => {
  assert.ok(source.includes("Local simulation - no data leaves this page"));
  assert.ok(source.includes("No digest, anchor, proof, or receipt was produced."));
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|WebSocket|@workspace\/api/);
  assert.match(source, /value=\{log\}/);
  assert.match(source, /setLog\(e\.target\.value\);\s*if \(phase !== "idle"\) reset\(\);/);
});

test("stale timers are cancelled and empty input cannot run an audit", () => {
  assert.match(source, /if \(empty \|\| busy\) return;/);
  assert.match(source, /disabled=\{empty \|\| busy\}/);
  assert.ok(source.includes("Enter a log sample to enable the audit."));
  assert.match(source, /window\.clearTimeout\(t\)/);
  assert.match(source, /if \(id === runId\.current\) fn\(\);/);
  assert.match(source, /useEffect\(\s*\(\) => \(\) => \{\s*runId\.current \+= 1;\s*clearTimers\(\);/);
  assert.match(source, /if \(phase !== "flagged"\) return;/);
  assert.match(source, /STEPS\.slice\(0, shown\)/);
});

test("the terminal is accessible, responsive and respects reduced motion", () => {
  assert.match(source, /htmlFor="a12s-log"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /a12s-pulse 1\.4s/);
});

test("the sandbox preserves live-terminal priority and exposes the checkout CTA", () => {
  const terminal = app.indexOf("<EscrowTerminal />");
  const sandbox = app.indexOf("<Article12Sandbox />");
  const commands = app.indexOf("<CommandCenter />");
  assert.ok(terminal >= 0 && sandbox > terminal && commands > sandbox);
  assert.ok(app.includes('data-testid="link-article12-sandbox"'));
  assert.ok(app.includes('href={`${import.meta.env.BASE_URL}#article12-sandbox`}'));
  assert.ok(source.includes('href="#stripe-checkout"'));
  assert.ok(source.includes("Replace this placeholder with the permanent Stripe checkout link."));
  assert.ok(source.includes('window.location.hash !== `#${ARTICLE12_SANDBOX_ID}`'));
  assert.match(source, /section\.current\?\.scrollIntoView/);
  assert.match(source, /phase === "secured" && \(\s*<>\s*<p className="a12s-success"/);
  assert.match(source, /<\/div>\s*{\/\* Replace this placeholder[^]*?<a\s+className="a12s-cta"/);
  assert.match(css, /\.a12s-cta\s*\{[^}]*background: hsl\(var\(--primary\)\);[^}]*color: hsl\(var\(--primary-foreground\)\)/s);
  assert.match(css, /\.a12s-cta svg\s*\{\s*flex-shrink: 0;/);
});
