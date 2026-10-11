// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const origin = "https://bitcoin-stratigraphy-dashboard.replit.app";
const load = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const { enterpriseSeoPlugin } = await tsImport(
  "../artifacts/bitcoin-stratigraphy-dashboard/enterprise-seo-plugin.ts", import.meta.url,
);

test("public static routes expose production canonicals and authored valid JSON-LD", () => {
  const plugin = enterpriseSeoPlugin();
  const template = load("artifacts/bitcoin-stratigraphy-dashboard/index.html");
  for (const path of ["/", "/simulator", "/compliance", "/standard", "/enterprise", "/whitepaper"]) {
    const html = plugin.transformIndexHtml.handler(template, { path });
    assert.ok(html.includes(`rel="canonical" href="${origin}${path}"`), path);
    assert.ok(html.includes(`property="og:url" content="${origin}${path}"`), path);
    const schemas = [...html.matchAll(
      /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    )].map((match) => JSON.parse(match[1]));
    assert.ok(schemas.length >= 2);
    const oracle = schemas.find((s) => s["@type"] === "SoftwareApplication");
    assert.equal(oracle.author.name, "Charles R. Strogish");
    assert.match(oracle.name, /L402 \+ RFC 6962/);
    assert.ok(oracle.license.includes("https://www.gnu.org/licenses/agpl-3.0.html"));
    assert.equal(oracle.url, origin + "/simulator");
  }
});

test("registry publisher attribution preserves existing release and 15-tool metadata", () => {
  const registry = JSON.parse(load("glama.json"));
  assert.equal(registry.publisher, "Charles R. Strogish");
  assert.equal(registry.website, origin + "/");
  assert.equal(registry.toolCount, 15);
  assert.equal(registry.version, "1.1.0");
  assert.equal(JSON.parse(load("mcp.json")).mcpServers["bitcoin-stratigraphy"].url, origin + "/mcp");
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
