import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { createFrontendApp } from "../server.mjs";

const { parseBlogPost, readBlogPosts } = await tsImport(
  "../blog/content.ts",
  import.meta.url,
);
const { blogPlugin, renderBlogDocument, blogSchema, blogSitemap } =
  await tsImport("../blog-plugin.ts", import.meta.url);
const title =
  "How to Make Autonomous AI Agents EU AI Act-Compliant Using Groth16 Proofs and Stripe";
const origin = "https://bitcoinstratigraphy.com";
const fixture = ({
  title = "Enterprise engineering",
  date = "2026-11-10",
  slug = "engineering",
  extra = "",
  body = "## A section\n\nReadable article text.",
} = {}) =>
  `---\ntitle: ${JSON.stringify(title)}\ndate: "${date}"\ndescription: "Engineering article description."\nslug: "${slug}"\n${extra}---\n\n${body}`;

test("Markdown preserves the requested title and supports placeholder articles", () => {
  const post = parseBlogPost(
    fixture({
      title,
      slug: "eu-ai-act-compliance-agents",
      body: "## Article coming soon\n\nPlaceholder: the full article text will be added here.",
    }),
  );
  assert.equal(post.title, title);
  assert.equal(post.slug, "eu-ai-act-compliance-agents");
  assert.ok(post.description);
  assert.match(post.html, /<h2>Article coming soon<\/h2>/);
  assert.match(
    post.html,
    /Placeholder: the full article text will be added here/,
  );
});

test("Markdown supports headings, lists, tables, links and fenced code with one document h1", () => {
  const post = parseBlogPost(
    fixture({
      body: "# Body heading\n\n- First item\n- Second item\n\n[Developer access](/developers/)\n\n```python\nprint('example')\n```\n\n| A | B |\n|---|---|\n| one | two |",
    }),
  );
  assert.match(post.html, /<h2>Body heading<\/h2>/);
  assert.match(post.html, /<ul>/);
  assert.match(post.html, /href="\/developers\/"/);
  assert.match(post.html, /class="language-python"/);
  assert.match(post.html, /<table>/);
  const html = renderBlogDocument([post], post);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
});

test("raw HTML and unsafe Markdown links cannot execute in article bodies", () => {
  const post = parseBlogPost(
    fixture({
      body: "<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))",
    }),
  );
  assert.doesNotMatch(post.html, /<script|href="javascript:/);
  assert.match(post.html, /&lt;script&gt;/);
});

for (const [label, source] of [
  ["missing frontmatter", "## Missing metadata"],
  ["missing title", fixture().replace(/^title:.*\n/m, "")],
  ["missing description", fixture().replace(/^description:.*\n/m, "")],
  ["invalid date", fixture({ date: "2026-02-31" })],
  ["path traversal slug", fixture({ slug: "../private" })],
  ["duplicate YAML keys", fixture({ extra: 'title: "Duplicate"\n' })],
  ["invalid draft flag", fixture({ extra: 'draft: "false"\n' })],
  ["empty body", fixture({ body: "" })],
]) {
  test(`publication rejects ${label}`, () => {
    assert.throws(() => parseBlogPost(source));
  });
}

test("directory discovery sorts by date, omits drafts, and rejects duplicate slugs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "blog-content-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "older.md"),
    fixture({ date: "2026-01-01", slug: "older" }),
  );
  await writeFile(path.join(directory, "newer.md"), fixture({ slug: "newer" }));
  await writeFile(
    path.join(directory, "draft.md"),
    fixture({ slug: "draft", extra: "draft: true\n" }),
  );
  assert.deepEqual(
    readBlogPosts(directory).map((post) => post.slug),
    ["newer", "older"],
  );
  await writeFile(
    path.join(directory, "duplicate.md"),
    fixture({ slug: "newer" }),
  );
  assert.throws(() => readBlogPosts(directory), /Duplicate blog slug/);
});

test("article initial head includes frontmatter metadata, canonical, social tags and BlogPosting", () => {
  const posts = [parseBlogPost(fixture({ title }))];
  const post = posts[0];
  const html = renderBlogDocument(posts, post);
  const head = html.split("</head>")[0];
  assert.match(head, new RegExp(`<title>${title}</title>`));
  assert.ok(
    head.includes(`<meta name="description" content="${post.description}">`),
  );
  assert.ok(
    head.includes(`<link rel="canonical" href="${origin}/blog/${post.slug}/">`),
  );
  assert.match(head, /property="og:type" content="article"/);
  const json = head.match(
    /<script id="blog-jsonld" type="application\/ld\+json">([^<]+)<\/script>/,
  );
  assert.ok(json);
  const schema = JSON.parse(json[1]);
  assert.equal(schema["@type"], "BlogPosting");
  assert.equal(schema.headline, post.title);
  assert.equal(schema.datePublished, `${post.date}T00:00:00Z`);
  assert.equal(schema.mainEntityOfPage["@id"], `${origin}/blog/${post.slug}/`);
  assert.match(html, /<article/);
  assert.match(html, /<h2>A section/);
  assert.doesNotMatch(html, /type="module"|src="[^"]+\.js"|id="root"/);
});

test("frontmatter is escaped in head HTML and cannot close the JSON-LD script", () => {
  const post = parseBlogPost(
    fixture({ title: '</title></script><script>alert("x")</script>' }),
  );
  const html = renderBlogDocument([post], post);
  assert.match(html, /&lt;\/title&gt;/);
  const schema = html.match(
    /<script id="blog-jsonld" type="application\/ld\+json">([^<]+)<\/script>/,
  );
  assert.equal(JSON.parse(schema[1]).headline, post.title);
  assert.doesNotMatch(html, /<script>alert/);
});

test("index has a Blog schema, native article links and prefixed asset/navigation paths", () => {
  const posts = [parseBlogPost(fixture())];
  const html = renderBlogDocument(posts, undefined, "/preview/");
  assert.equal(blogSchema()["@type"], "Blog");
  assert.match(html, /<main/);
  assert.match(html, /<h1/);
  assert.ok(html.includes(`href="/preview/blog/${posts[0].slug}/"`));
  assert.match(html, /href="\/preview\/favicon.png"/);
  assert.match(html, /href="\/preview\/developers"/);
});

test("build emits all blog documents and extends, rather than replaces, the sitemap", async () => {
  const emitted = [];
  blogPlugin().generateBundle.call({
    emitFile: (asset) => emitted.push(asset),
  });
  assert.deepEqual(
    emitted.map((asset) => asset.fileName),
    [
      "blog/index.html",
      ...readBlogPosts().map((post) => `blog/${post.slug}/index.html`),
      "sitemap.xml",
    ],
  );
  for (const document of emitted.filter((asset) =>
    asset.fileName.endsWith(".html"),
  )) {
    assert.match(document.source, /<main/);
    assert.doesNotMatch(document.source, /type="module"/);
  }
  const source = await readFile(
    new URL("../public/sitemap.xml", import.meta.url),
    "utf8",
  );
  const sitemap = blogSitemap(readBlogPosts());
  for (const location of source.match(/<loc>[^<]+<\/loc>/g))
    assert.ok(sitemap.includes(location));
  assert.ok(sitemap.includes(`<loc>${origin}/blog/</loc>`));
  for (const post of readBlogPosts())
    assert.ok(sitemap.includes(`<loc>${origin}/blog/${post.slug}/</loc>`));
});

test("production serves blog index and arbitrary generated slugs before the SPA, with real 404s", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "blog-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const posts = [parseBlogPost(fixture({ slug: "future-article" }))];
  await mkdir(path.join(directory, "blog/future-article"), { recursive: true });
  await writeFile(path.join(directory, "index.html"), "UNCHANGED SPA");
  await writeFile(
    path.join(directory, "blog/index.html"),
    renderBlogDocument(posts),
  );
  await writeFile(
    path.join(directory, "blog/future-article/index.html"),
    renderBlogDocument(posts, posts[0]),
  );
  const server = createFrontendApp({ publicDirectory: directory }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/blog/", "/blog/future-article/"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /Engineering/);
  }
  const redirect = await fetch(`${base}/blog/future-article`, {
    redirect: "manual",
  });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("location"), "/blog/future-article/");
  const missing = await fetch(`${base}/blog/does-not-exist/`);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /UNCHANGED SPA/);
  const head = await fetch(`${base}/blog/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(
    (await fetch(`${base}/api/fiat-mint/status`, { method: "POST" })).status,
    404,
  );
  assert.equal(await (await fetch(base)).text(), "UNCHANGED SPA");
});
