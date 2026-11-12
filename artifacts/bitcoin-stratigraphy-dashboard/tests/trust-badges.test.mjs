import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";

const source = await readFile(
  new URL("../src/components/trust-badges.tsx", import.meta.url),
  "utf8",
);
const compiled = await transformWithEsbuild(source, "trust-badges.tsx", {
  loader: "tsx",
  format: "cjs",
  jsx: "automatic",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.code)(
  createRequire(import.meta.url), module, module.exports,
);

test("shared Glama badge links to the enterprise listing and its dynamic score", () => {
  const url = "https://glama.ai/mcp/connectors/com.bitcoinstratigraphy/bitcoin-stratigraphy-enterprise-data-engine-and-agent-notary-hub";
  const html = renderToStaticMarkup(createElement(module.exports.TrustBadges));
  assert.ok(html.includes(`href="${url}"`));
  assert.ok(html.includes(`src="${url}/badges/score.svg"`));
  assert.match(html, /tool definition quality and endpoint health on Glama/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/mcpservers.org\/servers\/charlesstrogish\/bitcoin-stratigraphy-mcp"/);
  assert.doesNotMatch(html, /app\.replit/);
});
