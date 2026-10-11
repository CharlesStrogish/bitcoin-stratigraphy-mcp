import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const origin = "https://bitcoin-stratigraphy-dashboard.replit.app";
const load = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

function meta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/g) ?? [];
  const matching = tags.filter(
    (tag) => tag.includes(`name="${key}"`) || tag.includes(`property="${key}"`),
  );
  assert.equal(matching.length, 1, `Expected one ${key} tag`);
  return matching[0].match(/content="([^"]*)"/)?.[1] ?? "";
}

test("dashboard metadata preserves enterprise branding, attribution and batch-pricing discovery", async () => {
  const html = await load(
    "artifacts/bitcoin-stratigraphy-dashboard/index.html",
  );
  assert.equal((html.match(/<title>/g) ?? []).length, 1);
  assert.match(
    html,
    /<title>Bitcoin Stratigraphy Enterprise \| State-Anchored AI<\/title>/,
  );
  for (const key of ["og:title", "twitter:title"]) {
    assert.equal(meta(html, key), "Bitcoin Stratigraphy Enterprise | State-Anchored AI");
  }
  assert.equal(meta(html, "robots"), "index, follow");
  assert.ok(meta(html, "google-site-verification").length > 0);
  for (const key of ["description", "og:description", "twitter:description"]) {
    const content = meta(html, key);
    for (const feature of [
      /Enterprise-grade L402 data engine/,
      /cryptographic notary hub/,
      /State-Anchored AI data layers/,
      /Swarm Flight Recorders/,
      /EU AI Act Article 12 compliance/,
    ])
      assert.match(content, feature, key);
  }
  assert.equal(meta(html, "og:url"), origin + "/");
  assert.match(
    html,
    new RegExp(`rel="canonical" href="${origin.replaceAll(".", "\\.")}/"`),
  );
  assert.ok(
    html.includes(
      `title="MCP discovery manifest" href="${origin}/.well-known/mcp.json"`,
    ),
  );
  const json = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  assert.ok(json);
  const schema = JSON.parse(json[1]);
  assert.equal(schema["@context"], "https://schema.org");
  const graph = schema["@graph"];
  const person = graph.find((entry) => entry["@type"] === "Person");
  assert.equal(person["@id"], origin + "/#creator");
  assert.equal(person.name, "Charles R. Strogish");
  assert.equal(person.jobTitle, "Founder & Lead Architect");
  const dataset = graph.find((entry) => entry["@type"] === "Dataset");
  assert.equal(dataset.url, origin + "/");
  assert.equal(dataset.author["@id"], person["@id"]);
  assert.equal(dataset.creator["@type"], "Person");
  assert.equal(dataset.creator.name, person.name);
  assert.equal(dataset.license, "https://creativecommons.org/licenses/by/4.0/");
  assert.match(dataset.conditionsOfAccess, /POST \/api\/v1\/cost/);
  assert.match(dataset.conditionsOfAccess, /batch totals without generating invoices/);
  const api = graph.find(
    (entry) => entry["@type"] === "WebAPI",
  );
  assert.equal(api.documentation, origin + "/docs");
  assert.equal(api.url, origin + "/mcp");
  assert.match(api.description, /15 canonical MCP tools/);
  assert.match(api.description, /L402 Lightning micropayment settlement/);
  assert.ok(
    api.potentialAction.some(
      (entry) =>
        /itemized MCP batch pricing.*without generating invoices/.test(entry.name) &&
        entry.target.httpMethod === "POST" &&
        entry.target.urlTemplate === origin + "/api/v1/cost",
    ),
  );
});

test("crawler rules and sitemap include developer pages and MCP discovery", async () => {
  const robots = await load(
    "artifacts/bitcoin-stratigraphy-dashboard/public/robots.txt",
  );
  assert.match(robots, /^User-agent: \*$/m);
  // Public pages remain crawlable; only API data and internal files are excluded.
  assert.deepEqual(
    robots.split("\n").map((line) => line.trim()).filter(
      (line) => /^(User-agent|Allow|Disallow):/i.test(line),
    ),
    ["User-agent: *", "Allow: /", "Disallow: /api/", "Allow: /api/docs",
      "Disallow: /tmp/", "Disallow: /generated-artifacts/", "Disallow: /.data/",
      "Disallow: /.local/", "Disallow: /attached_assets/"],
  );
  assert.ok(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
  const xml = await load(
    "artifacts/bitcoin-stratigraphy-dashboard/public/sitemap.xml",
  );
  assert.match(xml, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1],
  );
  assert.equal(urls.length, new Set(urls).size);
  for (const path of [
    "/",
    "/simulator",
    "/compliance",
    "/standard",
    "/enterprise",
    "/whitepaper",
    "/docs",
    "/cookbooks",
    "/.well-known/mcp.json",
    "/cookbooks/l402_client.py",
    "/llms.txt",
    "/llms-full.txt",
    "/openapi.json",
    "/.well-known/mcp/server-card.json",
  ]) {
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
    for (const term of [
      origin + "/docs",
      origin + "/cookbooks",
      "Python SDK",
      "POST",
      "invoice",
    ]) {
      assert.ok(guide.includes(term), `${file}: ${term}`);
    }
  }
});
