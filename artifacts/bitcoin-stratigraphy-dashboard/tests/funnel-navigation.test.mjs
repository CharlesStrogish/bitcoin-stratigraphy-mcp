import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";
import { transformWithEsbuild } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";

const sourcePath = new URL("../src/components/funnel-navigation.tsx", import.meta.url);
const source = (await readFile(sourcePath, "utf8")).replace('import "@/pages/funnel.css";', "");
const output = await transformWithEsbuild(source, fileURLToPath(sourcePath), {
  loader: "tsx",
  format: "cjs",
  jsx: "automatic",
});
const filename = fileURLToPath(new URL("./navigation-render.cjs", import.meta.url));
const compiled = new Module(filename);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(dirname(filename));
compiled._compile(output.code, filename);
const html = renderToStaticMarkup(
  createElement(Router, { ssrPath: "/" }, createElement(compiled.exports.default)),
);
const css = await readFile(new URL("../src/pages/funnel.css", import.meta.url), "utf8");

test("navigation preserves desktop branding and provides an accessible mobile home icon", () => {
  assert.match(html, /Bitcoin <em>Stratigraphy<\/em>/);
  assert.match(html, /aria-label="Bitcoin Stratigraphy home"/);
  assert.match(html, /class="fn-nav-mark" aria-hidden="true">◆/);
  assert.match(css, /\.fn-nav-mark, .fn-nav-mobile-label\s*\{\s*display:\s*none/);
  assert.match(css, /\.fn-nav-brand\s*\{[^}]*white-space:\s*nowrap/s);
});

test("mobile revenue links are always inline with short copy and a primary Audit pill", () => {
  assert.doesNotMatch(html, /<button|aria-expanded|fn-nav-toggle/);
  assert.match(html, /class="fn-nav-choices"/);
  assert.match(html, /href="\/developers"/);
  assert.match(html, /href="\/audit"/);
  assert.match(html, /class="fn-nav-mobile-label" aria-hidden="true">API/);
  assert.match(html, /class="fn-nav-mobile-label" aria-hidden="true">Audit/);
  assert.match(html, /aria-label="Enterprise Audit"/);
  assert.match(css, /@media \(width < 768px\)/);
  assert.match(css, /\.fn-nav-choices\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(css, /\.fn-nav-link.fn-nav-audit\s*\{[^}]*background:\s*hsl\(var\(--fn-amber\)\)/s);
});
