import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";
import express from "../artifacts/bitcoin-stratigraphy-dashboard/node_modules/express/index.js";
import { createFrontendApp } from "../artifacts/bitcoin-stratigraphy-dashboard/server.mjs";
import { auditSources, dashboard, inspectHtml, inspectMarkdown, checkSnippet, repositoryLinkFailure, root, walk } from "./site-integrity.mjs";
import { launchAuditBrowser } from "./site-integrity-browser.mjs";
import { tsImport } from "tsx/esm/api";

const origin = "https://bitcoinstratigraphy.com";
export function internalLinkFailure({ file, href, pathname, response, routes }) {
  if (!response.ok) return `${file}: dead internal link ${href} (${response.status})`;
  if (response.type?.includes("text/html") && /<div id="root"><\/div>/.test(response.document) &&
      !routes.has(pathname) && !routes.has(`${pathname}/`))
    return `${file}: internal link fell through to SPA: ${href}`;
  return null;
}
function declaredReadRoutes() {
  const files = walk(path.join(root, "artifacts/api-server/src/routes"), (file) => file.endsWith(".ts") && !file.includes(".test."));
  const routes = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\.(?:get|head|all|use)\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]));
  for (const filename of files)
    for (const match of readFileSync(filename, "utf8").matchAll(/\.(?:get|head)\(\s*\[([^\]]+)\]/g))
      for (const route of match[1].matchAll(/["'](\/[^"']+)["']/g)) routes.push(route[1]);
  const constants = new Map();
  for (const filename of walk(path.join(root, "artifacts/api-server/src/lib"), (file) => file.endsWith(".ts") && !file.includes(".test.")))
    for (const match of readFileSync(filename, "utf8").matchAll(/export const (\w+)\s*=\s*["'](\/[^"']+)["']/g)) constants.set(match[1], match[2]);
  for (const filename of files)
    for (const match of readFileSync(filename, "utf8").matchAll(/\.(?:get|head)\(\s*([A-Z][A-Z_0-9]+)\s*,/g))
      if (constants.has(match[1])) routes.push(constants.get(match[1]));
  return routes;
}

export async function auditBuiltSite({ mobile = true } = {}) {
  const source = auditSources();
  const failures = [...source.failures];
  const output = path.join(dashboard, "dist/public");
  if (!existsSync(path.join(output, "index.html"))) throw new Error("Build the dashboard before the site integrity audit.");
  const documents = walk(output, (file) => file.endsWith(".html"));
  const app = express();
  // Serve the existing public documentation as files; no backend handlers execute.
  const { registerDocsRoutes } = await tsImport("../artifacts/api-server/src/routes/docs.ts", import.meta.url);
  const stagedPublic = mkdtempSync(path.join(tmpdir(), "site-integrity-docs-"));
  cpSync(path.join(root, "artifacts/api-server/src/public"), stagedPublic, { recursive: true });
  cpSync(path.join(root, "cookbooks"), path.join(stagedPublic, "cookbooks"), { recursive: true });
  registerDocsRoutes(app, stagedPublic);
  app.use(createFrontendApp({ publicDirectory: output }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const pages = [];
  const renderedDocuments = new Map();
  const linkChecks = new Map();
  const copies = [];
  try {
    const routes = new Set(documents.map((file) => {
      const relative = path.relative(output, file).split(path.sep).join("/");
      return `/${relative.replace(/index\.html$/, "")}`;
    }));
    // Include every React route, even if a new route lacks a prerendered document.
    for (const match of readFileSync(path.join(dashboard, "src/App.tsx"), "utf8").matchAll(/<Route\s+path="([^"]+)"/g)) routes.add(match[1]);
    routes.add("/docs");
    routes.add("/cookbooks");
    routes.add("/developers/enterprise-troubleshooting");
    browser = await launchAuditBrowser();
    for (const route of [...routes].sort()) {
      const response = await fetch(base + route);
      if (!response.ok) { failures.push(`${route}: HTTP ${response.status}`); continue; }
      const initial = await response.text();
      failures.push(...inspectHtml(initial, `${route} [built]`, { requireHero: !/<div id="root"><\/div>/.test(initial) }).failures);
      const rendered = await browser.inspect(base + route);
      const result = inspectHtml(rendered.html, route);
      renderedDocuments.set(route.replace(/\/$/, "") || "/", rendered.html);
      failures.push(...result.failures, ...rendered.errors.map((error) => `${route}: console error: ${error}`));
      for (const variant of rendered.variants)
        failures.push(...inspectHtml(variant, `${route} [tab]`).failures);
      if (/404 Page Not Found/i.test(rendered.headings.find((heading) => heading.level === 1)?.title ?? "")) failures.push(`${route}: SPA 404`);
      for (const copy of rendered.copies) {
        if (!copy.values.length) failures.push(`${route}: ${copy.label}: no clipboard payload captured`);
        for (const value of copy.values) failures.push(...(/\.md$/.test(copy.sourcePath)
          ? inspectMarkdown(value, `${route}: copied Markdown`).failures
          : checkSnippet(value, `${route}: ${copy.label}`, {
          language: /markdown|clause|intake/i.test(copy.label) ? "text" : "typescript",
        })));
        copies.push({ route, label: copy.label, payloads: copy.values.length });
      }
      for (const href of result.links) linkChecks.set(`${route}|${href}`, { file: route, href, html: rendered.html });
      if (mobile) {
        const phone = await browser.inspect(base + route, 390);
        failures.push(...inspectHtml(phone.html, `${route} [mobile]`).failures, ...phone.errors.map((error) => `${route}: mobile console error: ${error}`));
        if (phone.scrollWidth > phone.width + 1) failures.push(`${route}: mobile page overflow ${phone.scrollWidth}/${phone.width}`);
      }
      pages.push(route);
    }
    for (const { file, href } of source.markdownLinks) linkChecks.set(`${file}|${href}`, { file, href });
    const apiRoutes = declaredReadRoutes();
    const checkedUrls = new Map();
    for (const { file, href, html } of linkChecks.values()) {
      if (!href || /^(?:mailto|tel|data|javascript):/i.test(href)) continue;
      if (!file.startsWith("/") || /^https:\/\/github\.com\/CharlesStrogish\/bitcoin-stratigraphy-mcp\/(?:blob|tree)\/main\//i.test(href)) {
        const failure = repositoryLinkFailure(file, href);
        if (failure) failures.push(failure);
      }
      let url;
      try { url = new URL(href, `${origin}${file.startsWith("/") ? file : `/${file}`}`); }
      catch { failures.push(`${file}: invalid link ${href}`); continue; }
      if (url.origin !== origin) continue;
      if (!file.startsWith("/") && !href.startsWith("/") && !href.startsWith("http")) {
        continue;
      }
      if (href.startsWith("#") && html) {
        const id = decodeURIComponent(url.hash.slice(1));
        if (!html.includes(`id="${id}"`) && !html.includes(`name="${id}"`)) failures.push(`${file}: missing fragment ${href}`);
        continue;
      }
      if (url.hash) {
        const targetHtml = renderedDocuments.get(url.pathname.replace(/\/$/, "") || "/");
        const id = decodeURIComponent(url.hash.slice(1));
        if (targetHtml && !targetHtml.includes(`id="${id}"`) && !targetHtml.includes(`name="${id}"`))
          failures.push(`${file}: missing page fragment ${href}`);
      }
      // API links are checked against actual explicit route registrations, never
      // blanket prefix allowances or paid endpoint calls.
      const declared = apiRoutes.some((route) => route !== "/" && (url.pathname === route || url.pathname === `/api${route}`));
      if (declared && !routes.has(url.pathname) && !existsSync(path.join(output, url.pathname))) continue;
      if (!checkedUrls.has(url.pathname)) {
        const response = await fetch(base + url.pathname);
        checkedUrls.set(url.pathname, { ok: response.ok, status: response.status, type: response.headers.get("content-type"), document: await response.text() });
      }
      const response = checkedUrls.get(url.pathname);
      const failure = internalLinkFailure({file, href, pathname:url.pathname, response, routes});
      if (failure) failures.push(failure);
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(stagedPublic, { recursive: true, force: true });
  }
  return { failures: [...new Set(failures)], pages, markdownFiles: source.documents.length, clipboardSources: source.clipboard, copies, links: linkChecks.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const result = await auditBuiltSite({ mobile: !process.argv.includes("--desktop-only") });
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
