import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { parseBlogPost, readBlogPosts } = await tsImport("../blog/content.ts", import.meta.url);
const { blogSchema, blogSitemap, renderBlogDocument } = await tsImport("../blog-plugin.ts", import.meta.url);
const slug = "defending-autonomous-ai-swarms-mcp-tool-poisoning-hijacking";
const canonical = `https://bitcoinstratigraphy.com/blog/${slug}`;
const posts = readBlogPosts();
const post = posts.find((entry) => entry.slug === slug);
const source = await readFile(new URL(`../content/blog/${slug}.md`, import.meta.url), "utf8");
const primaryKeywords = [
  "MCP tool poisoning defense", "OWASP MCP03 mitigation",
  "AI agent hijacking prevention", "autonomous swarm drain attack",
  "EU AI Act Article 12 tamper-evident logging", "LangChain CrewAI zero-trust security",
  "L402 macaroon attenuation",
];
const schemaKeywords = [
  "MCP tool poisoning", "OWASP MCP03", "OWASP ASI02", "AI agent hijacking",
  "autonomous swarm security", "L402 macaroon attenuation", "EU AI Act Article 12",
  "NIP-98 kill switch", "OpenTimestamps",
];

test("swarm defense article preserves the approved body with URL and heading corrections", () => {
  const body = source.split("\n---\n")[1];
  assert.equal(createHash("sha256").update(body).digest("hex"),
    "e534bfecbdfd4eacd85ff672394c8efecff192035a466272946b15b4daea7f5a");
  assert.doesNotMatch(body, /Automated Compliance SLAs|100,000-sat Lightning invoice|Tier II Commercial Enterprise Exemption/);
  assert.match(body, /STRICTLY AS-IS, WITH ALL FAULTS/);
  assert.equal(post.title, "Defending Autonomous AI Swarms Against Hijacking, MCP Tool Poisoning, and Drain Attacks");
  assert.equal(post.description, "Stop OWASP MCP03 tool poisoning, prompt-injection hijacking, and wallet drain attacks in LangChain, CrewAI, and AutoGPT swarms with Ed25519 hash pinning, L402 macaroon attenuation, and NIP-98 kill switches.");
  assert.equal(post.date, "2026-11-19");
  assert.equal(post.dateModified, post.date);
  assert.equal(post.authorName, "Charles R. Strogish");
  assert.deepEqual(post.keywords, primaryKeywords);
  assert.deepEqual(post.schemaKeywords, schemaKeywords);
});

test("swarm defense code examples and JSON-LD contain only unmangled URLs and no duplicate body title", () => {
  const html = renderBlogDocument(posts, post);
  const blocks = [
    ...html.matchAll(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/g),
    ...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g),
  ];
  assert.ok(blocks.length > 4, "code examples and JSON-LD were inspected");
  for (const block of blocks) assert.doesNotMatch(block[0], /\[https:\/\//);
  assert.doesNotMatch(source.split("\n---\n")[0], /\[https:\/\//);
  assert.match(post.html, /^<p><strong>Published:<\/strong> November 19, 2026/);
  assert.doesNotMatch(post.html, /<h[12][^>]*>Defending Autonomous AI Swarms/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.equal((post.html.match(/<h2\b/g) ?? []).length, 4);
  assert.match(post.html, /<code class="language-bash">npx add-mcp 'https:\/\/bitcoinstratigraphy\.com\/mcp'\n<\/code>/);
  assert.ok(post.html.includes('fetch(&quot;https://bitcoinstratigraphy.com/.well-known/integrity.json&quot;)'));
  assert.ok(post.html.includes('&quot;https://bitcoinstratigraphy.com/api/v1/compliance/revocation-snapshot&quot;'));
  assert.ok(post.html.includes('endpoint=&quot;https://bitcoinstratigraphy.com/mcp&quot;'));
});

test("swarm defense initial head publishes exact canonical, social metadata and valid BlogPosting", () => {
  const html = renderBlogDocument(posts, post);
  const head = html.split("</head>")[0];
  assert.ok(head.includes(`<title>${post.title}</title>`));
  assert.ok(head.includes(`<link rel="canonical" href="${canonical}">`));
  assert.ok(head.includes(`<meta name="keywords" content="${primaryKeywords.join(", ")}">`));
  for (const [name, value] of [
    ["og:title", post.title], ["og:description", post.description],
    ["og:url", canonical], ["og:type", "article"],
  ]) assert.ok(head.includes(`<meta property="${name}" content="${value}">`));
  for (const [name, value] of [
    ["twitter:title", post.title], ["twitter:description", post.description],
    ["twitter:url", canonical], ["twitter:card", "summary_large_image"],
  ]) assert.ok(head.includes(`<meta name="${name}" content="${value}">`));
  const scripts = [...head.matchAll(/<script id="blog-jsonld" type="application\/ld\+json">([^<]+)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const schema = JSON.parse(scripts[0][1]);
  assert.deepEqual(schema, blogSchema(post));
  assert.equal(schema["@context"], "https://schema.org");
  assert.equal(schema["@type"], "BlogPosting");
  assert.equal(schema.headline, post.title);
  assert.equal(schema.description, post.description);
  assert.deepEqual(schema.author, { "@type": "Person", name: "Charles R. Strogish", url: "https://bitcoinstratigraphy.com/manifesto" });
  assert.equal(schema.publisher.name, "Bitcoin Stratigraphy");
  assert.equal(schema.datePublished, "2026-11-19T00:00:00Z");
  assert.equal(schema.dateModified, schema.datePublished);
  assert.equal(schema.mainEntityOfPage["@id"], canonical);
  assert.deepEqual(schema.keywords, schemaKeywords);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /Published:<\/strong> November 19, 2026/);
  assert.equal((post.html.match(/<table>/g) ?? []).length, 1);
  assert.equal((post.html.match(/<td\b/g) ?? []).length, 16);
  for (const language of ["typescript", "json", "python", "bash"])
    assert.ok(post.html.includes(`class="language-${language}"`));
  for (const href of ["/security", "/static/verify.html", "/developers/enterprise-troubleshooting"])
    assert.ok(post.html.includes(`href="${href}"`));
  assert.doesNotMatch(html, /type="module"|id="root"/);
});

test("swarm defense is newest and sitemap preserves older article canonicals", () => {
  assert.equal(posts[0].slug, slug);
  const index = renderBlogDocument(posts);
  const first = index.match(/data-testid="card-post-([^"]+)"/);
  assert.equal(first[1], slug);
  const sitemap = blogSitemap(posts);
  assert.ok(sitemap.includes(`<loc>${canonical}</loc><lastmod>2026-11-19</lastmod>`));
  for (const previous of posts.filter((entry) => entry.slug !== slug))
    assert.ok(sitemap.includes(`<loc>https://bitcoinstratigraphy.com/blog/${previous.slug}/</loc>`));
});

test("optional search metadata fails closed on invalid values", () => {
  for (const replacement of [
    'canonicalUrl: "https://attacker.test/blog/elsewhere"',
    'canonicalUrl: "javascript:alert(1)"',
    'canonicalUrl: "https://bitcoinstratigraphy.com/blog/different-post"',
  ]) assert.throws(() => parseBlogPost(source.replace(/^canonicalUrl:.*$/m, replacement)), /canonicalUrl/);
  for (const field of ["keywords", "schemaKeywords"]) {
    const minimal = `---\ntitle: "Test"\nslug: "test"\ndate: "2026-11-19"\ndescription: "Test"\n${field}: []\n---\nTest`;
    for (const value of ["[]", '[""]', "[false]", '"not a list"'])
      assert.throws(() => parseBlogPost(minimal.replace(`${field}: []`, `${field}: ${value}`)), new RegExp(field));
  }
});
