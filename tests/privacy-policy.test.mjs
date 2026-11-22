// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const root = new URL("../", import.meta.url);
const load = (file) => readFileSync(new URL(file, root), "utf8");
const require = createRequire(new URL("artifacts/bitcoin-stratigraphy-dashboard/package.json", root));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { default: PrivacyContent } = await tsImport(
  "../artifacts/bitcoin-stratigraphy-dashboard/src/pages/privacy-content.tsx",
  import.meta.url,
);

test("privacy notice renders factual records, processor policies and the verbatim commercial disclosure without tracking", () => {
  const html = renderToStaticMarkup(createElement(PrivacyContent));
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  for (const text of [
    "Privacy Policy", "NIP-98 public keys", "SHA-256 digests", "context hashes",
    "L402 payment hashes", "macaroon metadata", "IP-based rate-limiting counters",
    "Public Bitcoin transaction IDs", "licensee names and identifiers",
    "recipient email address", "checkout-session identifiers", "Brevo",
    "does not store raw credit card numbers", "watch-only public key derivation",
    "public and permanent", "air-gapped", "export/import process",
    "does not create custom DPAs, SLAs", "does not require account registration or passwords",
  ]) assert.ok(html.includes(text), text);
  for (const url of [
    "https://stripe.com/privacy", "https://www.brevo.com/legal/privacypolicy/",
    "https://bitcoinstratigraphy.com/#enterprise-licensing",
    "https://bitcoinstratigraphy.com/security",
  ]) assert.ok(html.includes(`href="${url}"`), url);
  const disclosure = load("LICENSE.md").split("\n").find(line => line.startsWith("All prepaid MCP Macro-Macaroons, Scanner Packs"));
  assert.ok(disclosure);
  assert.ok(html.includes(disclosure));
  assert.doesNotMatch(html, /<(?:script|iframe|form|img)\b/i);
  const nested = renderToStaticMarkup(createElement(PrivacyContent, { base: "/preview" }));
  assert.ok(nested.includes('href="/preview/privacy"'));
  assert.ok(nested.includes('href="/preview/docs"'));
});

test("privacy is routable, prerendered, linked from the footer and discoverable without blocking crawlers", () => {
  const site = "artifacts/bitcoin-stratigraphy-dashboard/";
  assert.ok(load(`${site}src/App.tsx`).includes('<Route path="/privacy" component={PrivacyPage} />'));
  assert.ok(load(`${site}src/components/site-footer.tsx`).includes('data-testid="link-footer-privacy"'));
  const plugin = load(`${site}enterprise-seo-plugin.ts`);
  assert.ok(plugin.includes('path: "privacy"'));
  assert.ok(plugin.includes("createElement(PrivacyContent"));
  for (const file of ["sitemap.xml", "llms.txt", "llms-full.txt"]) {
    assert.ok(load(`${site}public/${file}`).includes("https://bitcoinstratigraphy.com/privacy/"), file);
  }
  const robots = load(`${site}public/robots.txt`);
  assert.match(robots, /Allow: \//);
  assert.doesNotMatch(robots, /Disallow:\s*\/privacy/);
});
