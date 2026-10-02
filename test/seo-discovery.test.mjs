import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const origin = "https://bitcoin-stratigraphy-dashboard.replit.app";
const load = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

function meta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/g) ?? [];
  const matching = tags.filter((tag) =>
    tag.includes(`name="${key}"`) || tag.includes(`property="${key}"`));
  assert.equal(matching.length, 1, `Expected one ${key} tag`);
  return matching[0].match(/content="([^"]*)"/)?.[1] ?? "";
}

test("dashboard metadata describes the live developer and batch-pricing surfaces", async () => {
  const html = await load("artifacts/bitcoin-stratigraphy-dashboard/index.html");
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
  assert.match(html, /<title>Bitcoin Stratigraphy .*14 MCP Tools.*Docs.*L402 Pricing<\/title>/);
  for (const key of ["description", "og:description", "twitter:description"]) {
    const content = meta(html, key);
    for (const feature of [
      /14.*MCP tools/i, /4 namespaces/i, /\/docs/, /Live Tool Explorer/,
      /Python SDK/, /\/cookbooks/, /CrewAI/, /LangChain/, /AutoGen/,
      /L402 Lightning micropayments/, /batch POST pricing/,
    ]) assert.match(content, feature, key);
  }
  assert.equal(meta(html, "og:url"), origin + "/");
  assert.match(html, new RegExp(`rel="canonical" href="${origin.replaceAll(".", "\\.")}/"`));
  assert.ok(html.includes(`title="MCP discovery manifest" href="${origin}/.well-known/mcp.json"`));
  const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(json);
  const api = JSON.parse(json[1])["@graph"].find((entry) => entry["@type"] === "WebAPI");
  assert.equal(api.documentation, origin + "/docs");
  assert.ok(api.potentialAction.some((entry) =>
    /batch pricing/.test(entry.name) &&
    entry.target.httpMethod === "POST" &&
    entry.target.urlTemplate === origin + "/api/v1/cost"));
});

test("crawler rules and sitemap include developer pages and MCP discovery", async () => {
  const robots = await load("artifacts/bitcoin-stratigraphy-dashboard/public/robots.txt");
  assert.match(robots, /^User-agent: \*$/m);
  for (const path of ["/", "/docs", "/cookbooks", "/.well-known/mcp.json"]) {
    assert.ok(robots.split("\n").includes(`Allow: ${path}`));
  }
  assert.doesNotMatch(robots, /^Disallow:\s*\S/m);
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
  const xml = await load("artifacts/bitcoin-stratigraphy-dashboard/public/sitemap.xml");
  assert.match(xml, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.equal(urls.length, new Set(urls).size);
  for (const path of ["/", "/docs", "/cookbooks", "/.well-known/mcp.json", "/cookbooks/l402_client.py"]) {
    assert.ok(urls.includes(origin + path), path);
  }
  assert.ok(urls.every((url) => new URL(url).origin === origin));
});

test("developer pages, README and AI guides expose canonical documentation links", async () => {
  for (const [file, path] of [
    ["artifacts/api-server/src/public/docs/index.html", "/docs"],
    ["artifacts/api-server/src/public/cookbooks/index.html", "/cookbooks"],
  ]) {
    const html = await load(file);
    assert.ok(html.includes(`rel="canonical" href="${origin}${path}"`));
    assert.equal(meta(html, "og:url"), origin + path);
    assert.equal(meta(html, "robots"), "index, follow");
    assert.ok(meta(html, "description").length > 0);
    assert.ok(meta(html, "og:description").length > 0);
  }
  const readme = await load("README.md");
  const header = readme.split("\n").slice(0, 4).join("\n");
  assert.ok(header.includes(origin + "/docs"));
  assert.ok(header.includes(origin + "/cookbooks"));
  for (const file of [
    "artifacts/bitcoin-stratigraphy-dashboard/public/llms.txt",
    "artifacts/bitcoin-stratigraphy-dashboard/public/llms-full.txt",
  ]) {
    const guide = await load(file);
    for (const term of [origin + "/docs", origin + "/cookbooks", "Python SDK", "POST", "invoice"]) {
      assert.ok(guide.includes(term), `${file}: ${term}`);
    }
  }
});