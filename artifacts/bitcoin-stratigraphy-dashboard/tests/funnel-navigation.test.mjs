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

test("shared navigation keeps the full brand and removes the decorative diamond", () => {
  assert.match(html, /Bitcoin <em>Stratigraphy<\/em>/);
  assert.doesNotMatch(html, /fn-nav-mark|◆/);
  assert.doesNotMatch(css, /\.fn-nav-brand em\s*\{\s*display:\s*none/);
  assert.match(css, /\.fn-nav-brand\s*\{[^}]*white-space:\s*nowrap/s);
});

test("mobile navigation has an accessible closed toggle and both real page links", () => {
  assert.match(html, /aria-label="Open main menu" aria-expanded="false" aria-controls="primary-navigation-links"/);
  assert.match(html, /id="primary-navigation-links" class="fn-nav-choices"/);
  assert.match(html, /href="\/developers"/);
  assert.match(html, /href="\/audit"/);
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.match(css, /\.fn-nav-choices\.is-open\s*\{\s*display:\s*grid/);
});
