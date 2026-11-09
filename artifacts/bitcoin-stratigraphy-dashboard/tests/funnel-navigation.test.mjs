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

test("navigation preserves desktop branding and exposes a mobile home icon", () => {
  assert.match(html, /Bitcoin <em>Stratigraphy<\/em>/);
  assert.match(html, /aria-label="Bitcoin Stratigraphy home"/);
  assert.match(html, /<a href="\/" class="fn-nav-brand"[^>]*>.*fn-nav-brand-text.*fn-nav-mark.*<\/a>/);
  assert.match(css, /\.fn-nav-mark\s*\{\s*display:\s*none/);
  assert.match(css, /\.fn-nav-mobile-label\s*\{\s*display:\s*none/);
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

test("mobile funnels are centered, equally prominent and never pushed right", () => {
  const mobile = css.split("@media (width < 768px) {")[1].split("@media (max-width: 767px)")[0];
  assert.match(mobile, /\.fn-nav\s*\{[^}]*justify-content:\s*center/s);
  assert.match(mobile, /\.fn-nav-brand-text, .fn-nav-label, .fn-nav-hint\s*\{\s*display:\s*none/);
  assert.match(mobile, /\.fn-nav-mark\s*\{\s*display:\s*block/);
  assert.match(mobile, /\.fn-nav-brand\s*\{[^}]*position:\s*absolute/s);
  assert.match(mobile, /\.fn-nav-choices\s*\{[^}]*justify-content:\s*center;[^}]*margin:\s*0/s);
  assert.match(mobile, /font-size:\s*18px/);
  assert.match(mobile, /min-height:\s*56px/);
  assert.match(mobile, /padding:\s*16px 24px/);
  assert.doesNotMatch(mobile, /margin-left:\s*auto|justify-content:\s*(?:flex-end|end)/);
});

test("every route keeps a native homepage anchor without client-side interception", () => {
  for (const route of ["/", "/developers", "/audit", "/security", "/compliance", "/whitepaper"]) {
    const markup = renderToStaticMarkup(
      createElement(Router, { ssrPath: route }, createElement(compiled.exports.default)),
    );
    assert.match(markup, /<a href="\/" class="fn-nav-brand" aria-label="Bitcoin Stratigraphy home"/);
  }
  assert.match(source, /<a href="\/" className="fn-nav-brand"/);
  assert.doesNotMatch(source, /<Link href="\/"|preventDefault|onClick/);
  assert.match(css, /\.fn-nav-brand\s*\{[^}]*color:\s*inherit;[^}]*text-decoration:\s*none;[^}]*font-size:\s*15px/s);
});
