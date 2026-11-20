import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditSources, checkSnippet, inspectClipboard, inspectHtml, inspectMarkdown, repositoryLinkFailure, root } from "../scripts/site-integrity.mjs";
import { auditBuiltSite, internalLinkFailure, fragmentFailure, waiverLinkFailure } from "../scripts/audit-site-integrity.mjs";

test("site guard rejects mangled URLs in code, metadata, and JSON-LD", () => {
  for (const html of [
    '<h1>Test</h1><pre><code>fetch("[https://example.com](https://example.com)")</code></pre>',
    '<h1>Test</h1><meta name="description" content="[https://example.com](https://example.com)">',
    '<h1>Test</h1><script type="application/ld+json">{"url":"[https://example.com](https://example.com)"}</script>',
    '<h1>Test</h1><script type="application/ld+json">{"url":"\\u005bhttps://example.com](https://example.com)"}</script>',
    '<h1>Test</h1><button data-copy-text="[https://example.com](https://example.com)">Copy</button>',
  ]) assert.ok(inspectHtml(html, "fixture").failures.some((message) => message.includes("Markdown URL")));
  assert.ok(inspectMarkdown('# Test\n\n```bash\ncurl "[https://example.com](https://example.com)"\n```', "fixture.md").failures.length);
  assert.ok(checkSnippet('https://example.com](https://example.com)', "copy fixture").length);
});

test("site guard rejects executable smart quotes, nonbreaking spaces, and copied prompts", () => {
  for (const value of [
    "curl ‘https://example.com’", 'fetch(“https://example.com”)',
    "npm\u00a0install package", "pip\u202finstall package",
    "$ npm install package", ">>> print('hello')", "PS C:\\> npm install package",
  ]) assert.ok(checkSnippet(value, "fixture", { language: "bash" }).length, value);
  assert.deepEqual(checkSnippet("npx add-mcp 'https://bitcoinstratigraphy.com/mcp'", "fixture", { language: "bash" }), []);
  assert.deepEqual(checkSnippet("Customer’s existing legal terms", "prose", { language: "text" }), []);
  assert.deepEqual(checkSnippet("[![Badge](https://img.example/badge.svg)](https://example.com)", "badge"), []);
});

test("site guard rejects invalid JSON-LD, duplicate hero titles and skipped heading levels", () => {
  for (const html of [
    '<h1>Title</h1><script type="application/ld+json">{broken}</script>',
    "<h1>Title</h1><h1>Title</h1>",
    "<h1>Title</h1><h2>Title</h2>",
    "<h1>Title</h1><h3>Skipped</h3>",
  ]) assert.ok(inspectHtml(html, "fixture").failures.length);
  assert.deepEqual(inspectHtml('<h1>Title</h1><h2>Section</h2><script type="application/ld+json">{"@type":"WebPage"}</script>', "fixture").failures, []);
});

test("site guard rejects broken internal links, SPA soft 404s and missing documentation anchors", () => {
  const fixture = {file:"/",href:"/missing",pathname:"/missing",routes:new Set(["/"])};
  assert.match(internalLinkFailure({...fixture,response:{ok:false,status:404}}),/dead internal link/);
  assert.match(internalLinkFailure({...fixture,response:{ok:true,type:"text/html",document:'<div id="root"></div>'}}),/fell through to SPA/);
  assert.match(repositoryLinkFailure("README.md","definitely-missing-file.md"),/missing repository link/);
  assert.match(repositoryLinkFailure("README.md","#definitely-missing-heading"),/missing repository fragment/);
  assert.equal(repositoryLinkFailure("README.md","CONNECT.md"), null);
});

test("navigation guard rejects missing cross-page IDs, encoded fragments, and homepage redirects", () => {
  assert.equal(fragmentFailure("/enterprise", "/#enterprise-licensing", '<section id="enterprise-licensing">'), null);
  assert.match(fragmentFailure("/enterprise", "/#enterprise-licensing", '<section id="wrong">'), /missing page fragment/);
  assert.equal(fragmentFailure("/docs", "/docs#quoted%20section", "<h2 id='quoted section'>"), null);
  assert.match(fragmentFailure("/docs", "/docs#%zz", ""), /invalid fragment/);
  assert.match(internalLinkFailure({file:"/enterprise",href:"/missing",pathname:"/missing",response:{ok:true,status:200,pathname:"/"},routes:new Set(["/"])}), /redirected to homepage/);
});

test("waiver CTAs must use the one exact checkout target and same-page fragments", () => {
  assert.equal(waiverLinkFailure("/enterprise", "/#enterprise-licensing"), null);
  assert.equal(waiverLinkFailure("/", "#enterprise-licensing"), null);
  for (const href of ["/", "/enterprise#enterprise-licensing", "/#wrong", "https://example.com/#enterprise-licensing"])
    assert.match(waiverLinkFailure("/enterprise", href), /does not target the checkout/);
  assert.match(waiverLinkFailure("/", "/#enterprise-licensing"), /same-page/);
});

test("navigation guard includes button destinations and inline navigation handlers", () => {
  const result = inspectHtml(`<h1>Navigation</h1><button data-href="/enterprise">Enterprise</button>
    <button onclick="location.href='/missing#target'">Jump</button>`, "fixture");
  assert.deepEqual(result.links, ["/enterprise", "/missing#target"]);
});
test("site guard traces clipboard literals and inactive templated snippets", () => {
  const directory=mkdtempSync(path.join(tmpdir(),"site-copy-fixture-"));
  try {
    const filename=path.join(directory,"fixture.tsx");
    writeFileSync(filename, 'const snippet = `curl "[https://example.com](https://example.com/${path})"`; navigator.clipboard.writeText(snippet);');
    assert.ok(inspectClipboard(filename).failures.length);
    writeFileSync(filename, 'const snippet = "curl ‘https://example.com’"; navigator.clipboard.writeText(snippet);');
    assert.ok(inspectClipboard(filename).failures.some(message=>message.includes("smart quote")));
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("all repository Markdown, blog sources, and clipboard literals pass integrity checks", () => {
  const result = auditSources();
  assert.ok(result.documents.includes("README.md"));
  assert.ok(result.documents.includes("CONNECT.md"));
  assert.ok(result.documents.some((file) => file.startsWith("docs/")));
  assert.ok(result.documents.filter((file) => file.includes("/content/blog/")).length >= 5);
  assert.ok(result.clipboard.some((item) => item.location.includes("copy-text-button")));
  assert.ok(result.clipboard.some((item) => item.location.includes("portal.js")));
  assert.deepEqual(result.failures, []);
});

test("fresh production pages pass desktop/mobile, clipboard, markup and internal-link audit", { timeout: 300_000 }, async () => {
  const build = spawnSync("pnpm", ["--filter", "@workspace/bitcoin-stratigraphy-dashboard", "run", "build"], {
    cwd: root, env: { ...process.env, BASE_PATH: "/" }, encoding: "utf8", timeout: 150_000,
  });
  assert.equal(build.status, 0, `${build.error ?? ""}\n${build.stdout}\n${build.stderr}`);
  const result = await auditBuiltSite();
  assert.ok(result.pages.includes("/"));
  assert.ok(result.pages.includes("/docs"));
  assert.ok(result.pages.includes("/cookbooks"));
  assert.ok(result.pages.includes("/static/verify.html"));
  assert.ok(result.pages.some((route) => route.includes("defending-autonomous")));
  assert.ok(result.copies.length > 10);
  assert.ok(result.links > 100);
  assert.ok(result.waiverLinks.filter(link => link.file === "/enterprise").length >= 2);
  assert.ok(result.anchorChecks.length >= 14);
  assert.ok(result.anchorChecks.some(check => check.hashchange && check.width === 390));
  console.log(`Site integrity: ${result.pages.length} routes, ${result.markdownFiles} Markdown files, ${result.copies.length} clipboard controls, ${result.links} link occurrences.`);
  assert.deepEqual(result.failures, []);
});
