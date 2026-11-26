import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { readBlogPosts } = await tsImport("../blog/content.ts", import.meta.url);
const { blogSchema, blogSitemap, renderBlogDocument } = await tsImport(
  "../blog-plugin.ts",
  import.meta.url,
);
const slug = "l402-vs-x402-enterprise-mcp-servers-lightning-macaroons";
const canonical = `https://bitcoinstratigraphy.com/blog/${slug}`;
const title = "L402 vs. x402 for Enterprise MCP Servers: Why Capability Macaroons and Lightning Beat Stablecoin Wallets";
const description = "Compare L402 Lightning macaroons, x402 v2 USDC facilitators, and MPP on the wire—and wire LangChain, CrewAI, and Claude swarms to live Bitcoin settlement.";
const posts = readBlogPosts();
const post = posts.find((entry) => entry.slug === slug);
const source = await readFile(
  new URL(`../content/blog/${slug}.md`, import.meta.url),
  "utf8",
);

test("L06 preserves approved prose with only the two authorized Python URL corrections", () => {
  assert.ok(post);
  assert.equal(post.title, title);
  assert.equal(post.description, description);
  assert.equal(post.date, "2026-11-26");
  assert.equal(post.dateModified, post.date);
  assert.equal(post.canonicalUrl, canonical);
  assert.equal(post.authorName, "Charles R. Strogish");
  assert.equal(post.authorUrl, "https://bitcoinstratigraphy.com");
  const body = source.split("\n---\n")[1].trim();
  assert.equal(
    createHash("sha256").update(body).digest("hex"),
    "bb4d8bbf3fb8faa44dc41b9deaa8b441e5c58e5ff6ef5e6d570b26752eba1d96",
  );
  assert.ok(body.includes('MCP_ENDPOINT = "https://bitcoinstratigraphy.com/mcp"'));
  assert.ok(body.includes('INTEGRITY_URL = "https://bitcoinstratigraphy.com/.well-known/integrity.json"'));
  assert.deepEqual(post.keywords, [
    "L402 vs x402",
    "enterprise MCP server payments",
    "HTTP 402 AI agents",
    "Bitcoin Lightning L402 macaroons",
    "Model Context Protocol micropayments",
    "Stripe to Lightning failover",
    "BIP-84 cold storage AGPLv3 waiver",
  ]);
});

test("L06 head exposes complete BlogPosting with plain HTTPS URLs and exact social metadata", () => {
  const html = renderBlogDocument(posts, post);
  const head = html.split("</head>")[0];
  const scripts = [...head.matchAll(/<script id="blog-jsonld" type="application\/ld\+json">([^<]+)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const schema = JSON.parse(scripts[0][1]);
  assert.deepEqual(schema, blogSchema(post));
  assert.equal(schema["@context"], "https://schema.org");
  assert.equal(schema["@type"], "BlogPosting");
  assert.equal(schema.headline, title);
  assert.equal(schema.description, description);
  assert.equal(schema.datePublished, "2026-11-26T00:00:00Z");
  assert.equal(schema.dateModified, schema.datePublished);
  assert.deepEqual(schema.author, {
    "@type": "Person",
    name: "Charles R. Strogish",
    url: "https://bitcoinstratigraphy.com",
  });
  assert.deepEqual(schema.publisher, {
    "@type": "Organization",
    name: "Bitcoin Stratigraphy",
    url: "https://bitcoinstratigraphy.com/",
  });
  assert.deepEqual(schema.mainEntityOfPage, { "@type": "WebPage", "@id": canonical });
  assert.deepEqual(schema.keywords, [
    "L402 vs x402", "enterprise MCP server payments", "HTTP 402 AI agents",
    "Bitcoin Lightning L402", "capability macaroons", "Model Context Protocol",
  ]);
  for (const url of [
    schema["@context"], schema.author.url, schema.publisher.url,
    schema.mainEntityOfPage["@id"], schema.url,
  ]) assert.equal(new URL(url).protocol, "https:");
  assert.ok(head.includes(`<title>${title}</title>`));
  assert.ok(head.includes(`<link rel="canonical" href="${canonical}">`));
  for (const name of ["description", "og:description", "twitter:description"])
    assert.ok(head.includes(`="${name}" content="${description}"`));
  for (const name of ["og:title", "twitter:title"])
    assert.ok(head.includes(`="${name}" content="${title}"`));
});

test("L06 renders the comparison table, Python example, date, and all required internal links", () => {
  const html = renderBlogDocument(posts, post);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.equal((post.html.match(/<table>/g) ?? []).length, 1);
  assert.equal((post.html.match(/<td\b/g) ?? []).length, 28);
  assert.equal((post.html.match(/<h2\b/g) ?? []).length, 6);
  assert.ok(post.html.includes('class="language-python"'));
  assert.match(html, /dateTime="2026-11-26"[^>]*>Nov 26, 2026<\/time>/);
  for (const href of ["/docs", "/security", "/static/verify.html", "/#enterprise-licensing"])
    assert.ok(post.html.includes(`href="${href}"`));
  assert.doesNotMatch(html, /type="module"|id="root"|<form\b/);
});

test("L06 leads the six-entry index above L05 with shared navigation and styling", () => {
  assert.equal(posts.length, 6);
  assert.equal(posts[0].slug, slug);
  assert.equal(posts[1].slug, "defending-autonomous-ai-swarms-mcp-tool-poisoning-hijacking");
  const html = renderBlogDocument(posts);
  const cards = [...html.matchAll(/data-testid="card-post-([^"]+)"/g)];
  assert.equal(cards.length, 6);
  assert.equal(cards[0][1], slug);
  assert.equal(cards[1][1], posts[1].slug);
  assert.match(html, /data-testid="text-post-count">6 entries<\/p>/);
  assert.match(html, /class="blog-layer" aria-hidden="true">L06<\/span>/);
  assert.match(html, /class="blog-layer" aria-hidden="true">L05<\/span>/);
  assert.ok(html.includes(`href="/blog/${slug}/"`));
  assert.ok(html.includes(description));
  const prefixed = renderBlogDocument(posts, post, "/preview/");
  assert.ok(prefixed.includes('href="/preview/blog/"'));
});

test("L06 is registered exactly once in the generated sitemap without removing previous articles", () => {
  const sitemap = blogSitemap(posts);
  assert.equal(sitemap.split(`<loc>${canonical}</loc>`).length - 1, 1);
  assert.ok(sitemap.includes(`<loc>${canonical}</loc><lastmod>2026-11-26</lastmod>`));
  for (const previous of posts.filter((entry) => entry.slug !== slug)) {
    const url = previous.canonicalUrl ?? `https://bitcoinstratigraphy.com/blog/${previous.slug}/`;
    assert.ok(sitemap.includes(`<loc>${url}</loc>`));
  }
});
