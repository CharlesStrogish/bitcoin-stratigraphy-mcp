import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const origin = "https://bitcoinstratigraphy.com";
const load = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("homepage favicon points to a public square PNG", async () => {
  const html = await load("artifacts/bitcoin-stratigraphy-dashboard/index.html");
  assert.ok(
    html.includes('<link rel="icon" type="image/png" href="/favicon.png" />'),
  );
  assert.equal((html.match(/<link rel="icon"/g) ?? []).length, 1);
  const png = await readFile(
    new URL("../artifacts/bitcoin-stratigraphy-dashboard/public/favicon.png", import.meta.url),
  );
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
  assert.ok(png.readUInt32BE(16) >= 48);
});

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
    /<title>Bitcoin Stratigraphy \| Enterprise MCP Server & L402 Oracle<\/title>/,
  );
  for (const key of ["og:title", "twitter:title"]) {
    assert.equal(meta(html, key), "Bitcoin Stratigraphy | Enterprise MCP Server & L402 Oracle");
  }
  assert.equal(meta(html, "robots"), "index, follow");
  const verificationTags = [
    ...html.matchAll(/<meta name="google-site-verification" content="([^"]+)" \/>/g),
  ].map(([, token]) => token);
  assert.deepEqual(verificationTags, [
    "gD8puclen7IOEc0MSQGVzV61VebIvL3fn1VRWLVc-BE",
    "gD8puclen7lOEc0MSQGVzV61VeblvL3fn1VRWLVc-BE",
    "5-KfH4O096Z1k7nLsVu8839zUzv8mz0ItthQIGYjC28",
  ]);
  for (const key of ["description", "og:description", "twitter:description"]) {
    assert.equal(
      meta(html, key),
      "Enterprise MCP server and L402 oracle providing state-anchored AI telemetry, cryptographic flight recorders, and EU AI Act Article 12 compliance logging.",
      key,
    );
  }
  assert.equal(meta(html, "og:url"), origin + "/");
  assert.equal(meta(html, "twitter:url"), origin + "/");
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
  assert.deepEqual(person.jobTitle, [
    "Creator & Principal Architect",
    "Founder & Lead Architect",
  ]);
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
  assert.match(api.description, /16 canonical MCP tools/);
  assert.match(api.description, /L402 Lightning micropayment settlement/);
  assert.ok(
    api.potentialAction.some(
      (entry) =>
        /itemized MCP batch pricing.*without generating invoices/.test(entry.name) &&
        entry.target.httpMethod === "POST" &&
        entry.target.urlTemplate === origin + "/api/v1/cost",
    ),
  );
  assert.match(api.description, /Path A preimage or Path B NWC_LOOKUP/);
  const software = graph.find(
    (entry) => entry["@type"] === "SoftwareApplication",
  );
  assert.equal(software["@id"], origin + "/#software");
  assert.equal(software.url, origin + "/");
  assert.equal(software.author["@id"], person["@id"]);
  assert.match(software.description, /npx -y @bitcoin-stratigraphy\/mcp-server/);
  const pkg = JSON.parse(await load("package.json"));
  assert.equal(software.softwareVersion, pkg.version);
  const offers = new Map(software.offers.map((offer) => [offer["@id"], offer]));
  const l402 = offers.get(origin + "/#l402-access");
  assert.equal(l402.price, "0.00000024");
  assert.equal(l402.priceCurrency, "BTC");
  assert.match(l402.description, /<macaroon>:<preimage>/);
  assert.match(l402.description, /<macaroon>:NWC_LOOKUP/);
  const license = offers.get(origin + "/#commercial-license");
  assert.equal(license.name, "Commercial Enterprise License (Starting at $250k/Annual)");
  assert.match(license.description, /licensing@bitcoinstratigraphy\.com/);
  assert.deepEqual(
    api.offers.map((offer) => offer["@id"]).sort(),
    [...offers.keys()].sort(),
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
  // Dedicated pages are static directory indexes: the bare path redirects to
  // the trailing-slash URL, so only the final URL belongs in the sitemap.
  for (const page of ["simulator", "compliance", "standard", "enterprise", "whitepaper"]) {
    assert.ok(urls.includes(`${origin}/${page}/`), page);
    assert.ok(!urls.includes(`${origin}/${page}`), page);
  }
  for (const path of [
    "/",
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
      "npx -y @bitcoin-stratigraphy/mcp-server",
      "Authorization: L402 <macaroon>:<preimage>",
      "Authorization: L402 <macaroon>:NWC_LOOKUP",
      origin + "/api/v1/escrow/genesis-receipt",
      "ba4f25dd-7f16-420c-9264-a16f102fd5a6",
      "AGPL",
      "Starting at $250k/Annual",
      "licensing@bitcoinstratigraphy.com",
    ]) {
      assert.ok(guide.includes(term), `${file}: ${term}`);
    }
    assert.doesNotMatch(guide, /replit\.app/, file);
  }
  // The full guide documents every canonical tool from the live registry.
  const full = await load(
    "artifacts/bitcoin-stratigraphy-dashboard/public/llms-full.txt",
  );
  for (const name of [
    "stratigraphy.list",
    "stratigraphy.get",
    "stratigraphy.get_digest",
    "stratigraphy.get_diff",
    "stratigraphy.get_range",
    "proof.attenuate",
    "proof.verify",
    "proof.get_by_hash",
    "proof.list",
    "proof.submit",
    "proof.notarize",
    "proof.ground",
    "mesh.get_status",
    "mesh.broadcast",
    "payment.get_info",
  ]) {
    const escaped = name.replace(".", "\\.");
    assert.match(full, new RegExp(`^#{2,4} (?:\\d+\\. )?${escaped} — `, "m"), name);
  }
});
