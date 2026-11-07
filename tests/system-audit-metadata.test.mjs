// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const origin = "https://bitcoinstratigraphy.com";
const load = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const { enterpriseSeoPlugin } = await tsImport(
  "../artifacts/bitcoin-stratigraphy-dashboard/enterprise-seo-plugin.ts", import.meta.url,
);

test("public static routes expose production canonicals and authored valid JSON-LD", () => {
  const plugin = enterpriseSeoPlugin();
  const template = load("artifacts/bitcoin-stratigraphy-dashboard/index.html");
  for (const path of ["/", "/simulator", "/compliance", "/standard", "/enterprise", "/whitepaper", "/manifesto", "/security"]) {
    const html = plugin.transformIndexHtml.handler(template, { path });
    // Dedicated pages are directory indexes; their canonical ends with "/".
    const url = path === "/" ? `${origin}/` : `${origin}${path}/`;
    assert.ok(html.includes(`rel="canonical" href="${url}"`), path);
    assert.ok(html.includes(`property="og:url" content="${url}"`), path);
    const schemas = [...html.matchAll(
      /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    )].map((match) => JSON.parse(match[1]));
    assert.ok(schemas.length >= 2);
    const oracle = schemas.find((s) => s["@type"] === "SoftwareApplication");
    assert.equal(oracle.author.name, "Charles R. Strogish");
    assert.match(oracle.name, /L402 \+ RFC 6962/);
    assert.ok(oracle.license.includes("https://www.gnu.org/licenses/agpl-3.0.html"));
    assert.equal(oracle.url, origin + "/simulator/");
  }
});

test("each dedicated page is served its own head, not the homepage's", () => {
  // Production rewrites are matched before the static files, so a page
  // without its own rewrite falls through to the "/*" homepage rewrite.
  const toml = load("artifacts/bitcoin-stratigraphy-dashboard/.replit-artifact/artifact.toml");
  const rewrites = [...toml.matchAll(
    /\[\[services\.production\.rewrites\]\]\s*from = "([^"]+)"\s*to = "([^"]+)"/g,
  )].map((match) => [match[1], match[2]]);
  const catchAll = rewrites.findIndex(([from]) => from === "/*");
  assert.ok(catchAll >= 0);
  for (const page of ["simulator", "compliance", "standard", "enterprise", "whitepaper", "manifesto", "security"]) {
    for (const from of [`/${page}`, `/${page}/`]) {
      const index = rewrites.findIndex(([source]) => source === from);
      assert.ok(index >= 0 && index < catchAll, from);
      assert.equal(rewrites[index][1], `/${page}/index.html`, from);
    }
  }
});

test("manifesto serves its full article, metadata and conversion links without overwriting the whitepaper", () => {
  const plugin = enterpriseSeoPlugin();
  const template = load("artifacts/bitcoin-stratigraphy-dashboard/index.html");
  const html = plugin.transformIndexHtml.handler(template, { path: "/manifesto/" });
  assert.match(html, /<title>Bitcoin Stratigraphy \| The Global Central Bank for Autonomous AI<\/title>/);
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
  for (const section of [
    "fiduciary-armor", "fiduciary-oracle", "developer-friction", "canonical-tools",
    "agent-directives", "enterprise-exemption", "legal",
  ]) assert.ok(html.includes(`id="${section}"`), section);
  for (const id of ["link-starter-top", "link-starter-bottom"]) {
    assert.match(html, new RegExp(`<a[^>]*href="https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/tree/main/starter-swarm-python"[^>]*data-testid="${id}"`));
  }
  assert.ok(html.includes('href="mailto:licensing@bitcoinstratigraphy.com"'));
  assert.match(html, /href="\/whitepaper"[^>]*>Truth Receipts<\/a>/);
  assert.match(html, /href="\/whitepaper"[^>]*>compliance<\/a>/);
  assert.match(html, /href="\/whitepaper"[^>]*>circuit breakers<\/a>/);
  assert.ok(html.includes("Mandatory law and applicable signed agreements govern enforceability; obtain qualified legal review."));
  assert.ok(html.includes('id="manifesto-article-jsonld"'));
  const whitepaper = plugin.transformIndexHtml.handler(template, { path: "/whitepaper" });
  assert.match(whitepaper, /<title>Technical Whitepaper: State-Anchored AI Architecture &amp; Article 12 Compliance<\/title>/);
  assert.ok(!whitepaper.includes('id="manifesto-article-jsonld"'));
  assert.ok(!whitepaper.includes('class="mf-page"'));
  assert.ok(load("artifacts/bitcoin-stratigraphy-dashboard/public/sitemap.xml").includes(`${origin}/manifesto/`));
  assert.ok(load("artifacts/bitcoin-stratigraphy-dashboard/src/components/site-footer.tsx").includes("link-footer-manifesto"));
});

test("manifesto trust badge exposes the exact embeddable Markdown before the final CTA", () => {
  const plugin = enterpriseSeoPlugin();
  const html = plugin.transformIndexHtml.handler(
    load("artifacts/bitcoin-stratigraphy-dashboard/index.html"), { path: "/manifesto/" },
  );
  const badgeUrl = "https://img.shields.io/badge/Secured_by-Bitcoin_Stratigraphy-F7931A?style=for-the-badge&logo=bitcoin&logoColor=white";
  const markdown = `[![Secured by Bitcoin Stratigraphy](${badgeUrl})](https://bitcoinstratigraphy.com)`;
  const section = html.match(/<section id="fiduciary-trust-badge"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  assert.ok(section.includes("8. The Fiduciary Trust Badge"));
  assert.ok(section.includes(`src="${badgeUrl.replaceAll("&", "&amp;")}"`));
  const code = section.match(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/)?.[1];
  assert.equal(code?.replaceAll("&amp;", "&"), markdown);
  assert.ok(section.includes("Copy Markdown"));
  assert.ok(section.includes('role="status"'));
  assert.ok(html.includes('href="#fiduciary-trust-badge"'));
  assert.ok(html.indexOf('id="fiduciary-trust-badge"') < html.indexOf('aria-label="Get started"'));
});

test("security attestation is public, prerendered and interlinked without changing the whitepaper", () => {
  const plugin = enterpriseSeoPlugin();
  const template = load("artifacts/bitcoin-stratigraphy-dashboard/index.html");
  for (const path of ["/security", "/security/"]) {
    const html = plugin.transformIndexHtml.handler(template, { path });
    assert.match(html, /<title>Security Attestation \| Bitcoin Stratigraphy<\/title>/);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.match(html, /Zero-Trust Security Attestation &amp; AI Audit Report/);
    for (const text of [
      "Claude Opus 5.5 (Multi-Agent Swarm via Replit MAX Mode - Highest Thinking Protocol)",
      "12-Hour Continuous Penetration &amp; Logic Audit",
      "700+ rigorous regression and penetration tests",
      "0 critical, high, medium, or low vulnerabilities",
      "Macaroon Attenuation",
      "Signature Forgery",
      "Payload Tampering Rejection",
      "Cache Poisoning &amp; Leakage",
      "Machine-Readable Verification",
      "max_spend_sats",
      "tool_name:timestamp:contentSha256",
      "FiduciaryTamperingError",
      "guaranteeing zero risk of runaway context billing.",
    ]) assert.ok(html.includes(text), text);
    assert.match(html, /name="description" content="[^"]*700-test zero-vulnerability/);
    assert.ok(html.includes('id="security-article-jsonld"'));
    assert.ok(!html.includes('id="manifesto-article-jsonld"'));
  }
  const manifesto = plugin.transformIndexHtml.handler(template, { path: "/manifesto" });
  assert.match(manifesto, /href="\/security"[^>]*>View the 700-Point AI Security Audit<\/a>/);
  const footer = load("artifacts/bitcoin-stratigraphy-dashboard/src/components/site-footer.tsx");
  assert.ok(footer.includes("link-footer-security"));
  assert.ok(load("artifacts/bitcoin-stratigraphy-dashboard/public/sitemap.xml").includes(`${origin}/security/`));
  const whitepaper = plugin.transformIndexHtml.handler(template, { path: "/whitepaper" });
  assert.ok(!whitepaper.includes('id="security-article-jsonld"'));
});

test("registry publisher attribution preserves existing release and 16-tool metadata", () => {
  const registry = JSON.parse(load("glama.json"));
  assert.equal(registry.publisher, origin);
  assert.equal(registry.website, origin + "/");
  assert.equal(registry.toolCount, 16);
  assert.equal(registry.version, JSON.parse(load("package.json")).version);
  assert.equal(JSON.parse(load("mcp.json")).mcpServers["bitcoin-stratigraphy"].url, origin + "/mcp");
  assert.equal(JSON.parse(load("mcp.json")).url, origin);
  assert.equal(JSON.parse(load("mcp.json")).publisher, origin);
  const serverInfo = load("artifacts/api-server/src/lib/mcp-stateless.ts");
  assert.match(serverInfo, /websiteUrl: CANONICAL_ORIGIN/);
  const discovery = load("artifacts/api-server/src/lib/mcp-discovery-manifest.ts");
  for (const field of ["homepage", "origin", "publisher"])
    assert.ok(discovery.includes(`${field}: CANONICAL_ORIGIN`), field);
});

test("public audit download has the exact SHA-256 advertised in the security page", () => {
  const artifact = JSON.parse(load(
    "artifacts/bitcoin-stratigraphy-dashboard/src/lib/security-audit-artifact.json",
  ));
  assert.equal(artifact.filename, "opus-max-audit-log-2026.txt");
  const bytes = readFileSync(new URL(
    `../artifacts/bitcoin-stratigraphy-dashboard/public/${artifact.filename}`,
    import.meta.url,
  ));
  assert.equal(artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
  const html = enterpriseSeoPlugin().transformIndexHtml.handler(
    load("artifacts/bitcoin-stratigraphy-dashboard/index.html"), { path: "/security" },
  );
  assert.match(html, /Raw Audit Log:/);
  assert.match(html, /Artifact SHA-256:/);
  assert.ok(html.includes(artifact.sha256));
  assert.match(html, /href="\/opus-max-audit-log-2026\.txt" download="opus-max-audit-log-2026\.txt"/);
  assert.match(bytes.toString("utf8"), /Validation summary/);
  assert.match(bytes.toString("utf8"), /not proof of auditor identity/i);
});

test("documentation structured data and sitemap dates use the production domain", () => {
  const html = load("artifacts/api-server/src/public/docs/index.html");
  const schema = JSON.parse(html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )[1]);
  assert.equal(schema["@type"], "WebAPI");
  assert.equal(schema.author.name, "Charles R. Strogish");
  assert.equal(schema.documentation, origin + "/docs");
  const xml = load("artifacts/bitcoin-stratigraphy-dashboard/public/sitemap.xml");
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  assert.ok(entries.length >= 14);
  for (const entry of entries) {
    assert.match(entry, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    assert.equal(new URL(entry.match(/<loc>([^<]+)<\/loc>/)[1]).origin, origin);
  }
});
