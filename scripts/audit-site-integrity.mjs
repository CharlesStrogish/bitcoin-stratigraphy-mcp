import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";
import express from "../artifacts/bitcoin-stratigraphy-dashboard/node_modules/express/index.js";
import { createFrontendApp } from "../artifacts/bitcoin-stratigraphy-dashboard/server.mjs";
import { auditSources, dashboard, inspectHtml, inspectMarkdown, checkSnippet, repositoryLinkFailure, root, walk } from "./site-integrity.mjs";
import { launchAuditBrowser } from "./site-integrity-browser.mjs";
import { tsImport } from "tsx/esm/api";
import { registerNavigationApi } from "./site-navigation-api.mjs";

const origin = "https://bitcoinstratigraphy.com";
export function internalLinkFailure({ file, href, pathname, response, routes }) {
  if (!response.ok || response.status !== undefined && response.status !== 200) return `${file}: dead internal link ${href} (${response.status})`;
  if (response.pathname === "/" && pathname !== "/") return `${file}: internal link redirected to homepage: ${href}`;
  if (response.type?.includes("text/html") && /<div id="root"><\/div>/.test(response.document) &&
      !routes.has(pathname) && !routes.has(`${pathname}/`))
    return `${file}: internal link fell through to SPA: ${href}`;
  return null;
}
export function fragmentFailure(file, href, html) {
  const hash = new URL(href, origin).hash;
  if (!hash) return null;
  let id;
  try { id = decodeURIComponent(hash.slice(1)); }
  catch { return `${file}: invalid fragment ${href}`; }
  const ids = new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]));
  return ids.has(id) ? null : `${file}: missing page fragment ${href}`;
}
export function waiverLinkFailure(file, href) {
  const url = new URL(href, `${origin}${file}`);
  if (url.origin !== origin || url.pathname !== "/" || url.hash !== "#enterprise-licensing")
    return `${file}: waiver CTA does not target the checkout: ${href}`;
  if (file === "/" && href !== "#enterprise-licensing")
    return `${file}: same-page waiver CTA must use #enterprise-licensing: ${href}`;
  return null;
}

export async function auditBuiltSite({ mobile = true } = {}) {
  const source = auditSources();
  const failures = [...source.failures];
  const output = path.join(dashboard, "dist/public");
  if (!existsSync(path.join(output, "index.html"))) throw new Error("Build the dashboard before the site integrity audit.");
  const documents = walk(output, (file) => file.endsWith(".html"));
  const app = express();
  const cleanupApi = await registerNavigationApi(app);
  // Serve public documentation alongside the allowlisted read-only API handlers.
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
  const waiverLinks = [];
  const anchorChecks = [];
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
      for (const variant of rendered.variants) {
        const tab = inspectHtml(variant, `${route} [tab]`);
        failures.push(...tab.failures);
        for (const href of tab.links) linkChecks.set(`${route}|${href}`, { file: route, href, html: variant });
      }
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
      for (const match of rendered.html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const label = match[2].replace(/<[^>]*>/g, " ");
        if (!/(?:buy|purchase|self.serve).*waiver|waiver.*(?:buy|purchase)/i.test(label) && !match[1].includes("#enterprise-licensing")) continue;
        const failure = waiverLinkFailure(route, match[1]);
        if (failure) failures.push(failure);
        waiverLinks.push({ file: route, href: match[1] });
      }
      if (mobile) {
        const phone = await browser.inspect(base + route, 390);
        failures.push(...inspectHtml(phone.html, `${route} [mobile]`).failures, ...phone.errors.map((error) => `${route}: mobile console error: ${error}`));
        if (phone.scrollWidth > phone.width + 1) failures.push(`${route}: mobile page overflow ${phone.scrollWidth}/${phone.width}`);
      }
      pages.push(route);
    }
    for (const { file, href } of source.markdownLinks) linkChecks.set(`${file}|${href}`, { file, href });
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
      const key = url.pathname + url.search;
      if (!checkedUrls.has(key)) {
        const response = await fetch(base + key);
        checkedUrls.set(key, { ok: response.ok, status: response.status, pathname: new URL(response.url).pathname, type: response.headers.get("content-type"), document: await response.text() });
      }
      const response = checkedUrls.get(key);
      const failure = internalLinkFailure({file, href, pathname:url.pathname, response, routes});
      if (failure) failures.push(failure);
      if (url.hash) {
        const targetHtml = renderedDocuments.get(url.pathname.replace(/\/$/, "") || "/") ?? response.document;
        const missing = fragmentFailure(file, href, targetHtml);
        if (missing) failures.push(missing);
      }
    }
    for (const width of mobile ? [1440, 390] : [1440]) {
      for (const [url, selector, hashchange] of [
        ["/", undefined, false],
        ["/#enterprise-licensing", undefined, false],
        ["/#enterprise-licensing", undefined, true],
        ["/enterprise", '[data-testid="link-contact-sales"]', false],
        ["/enterprise", '[data-testid="link-contact-sales-bottom"]', false],
        ["/#mcp-tools", undefined, false],
        ["/developers#dev-prepaid", undefined, false],
      ]) {
        const state = await browser.checkAnchor(base + url, width, selector, hashchange);
        anchorChecks.push({ url, width, selector, hashchange, ...state });
        if (!state.hash) {
          if (state.scrollY !== 0) failures.push(`${url} (${width}): hashless load changed scroll position`);
          continue;
        }
        if (state.top === undefined || state.top < state.headerBottom - 1 || state.top >= state.height)
          failures.push(`${url} (${width}): fragment not visible below sticky header: ${JSON.stringify(state)}`);
        if (state.hash === "#enterprise-licensing" && (!state.checkout || state.tiers !== 4 || !state.licensee || !state.identifier || state.licenseeTop >= state.height))
          failures.push(`${url} (${width}): waiver target does not contain the four tiers and licensee form`);
      }
    }
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(stagedPublic, { recursive: true, force: true });
    cleanupApi();
  }
  return { failures: [...new Set(failures)], pages, markdownFiles: source.documents.length, clipboardSources: source.clipboard, copies, links: linkChecks.size, waiverLinks, anchorChecks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const result = await auditBuiltSite({ mobile: !process.argv.includes("--desktop-only") });
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
