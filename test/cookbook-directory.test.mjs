import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(
  new URL("../artifacts/api-server/src/public/cookbooks/index.html", import.meta.url),
  "utf8",
);

test("cookbook directory advertises the current catalog and enterprise security", () => {
  const text = html.replace(/\s+/g, " ");
  assert.match(text, /Integrate 16 live MCP tools across 5 namespaces/);
  assert.doesNotMatch(text, /15 (?:live )?MCP tools|4 namespaces/);
  for (const feature of [
    "Stateless MCP 2026-07-28 transport",
    "NIP-98 agent identity headers",
    "Ed25519 signed response verification",
  ]) {
    assert.ok(text.includes(feature), feature);
  }
  assert.doesNotMatch(text, /SDK natively supports/);
});

test("cookbook licensing CTA is a direct email link with responsive wrapping", () => {
  assert.match(
    html,
    /<a class="btn primary license-cta" href="mailto:licensing@bitcoinstratigraphy\.com">Deploying internally\? Request Commercial Enterprise License<\/a>/,
  );
  assert.match(html, /\.license-cta \{[^}]*max-width: 100%[^}]*white-space: normal/);
});
