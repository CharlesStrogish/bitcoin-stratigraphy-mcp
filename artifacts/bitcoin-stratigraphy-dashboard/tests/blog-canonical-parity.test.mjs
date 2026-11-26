import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { createFrontendApp } from "../server.mjs";

const { parseBlogPost, readBlogPosts } = await tsImport(
  "../blog/content.ts", import.meta.url,
);
const { blogSitemap, renderBlogDocument } = await tsImport(
  "../blog-plugin.ts", import.meta.url,
);
const origin = "https://bitcoinstratigraphy.com";
const futureSlug = "future-canonical-parity-fixture";
const futureSource = (extra = "") => `---
title: "Future article"
date: "2099-01-01"
description: "Future-entry canonical regression fixture."
slug: "${futureSlug}"
${extra}---

## Future article

Regression fixture, not a published entry.
`;

test("future canonical overrides must equal the final same-site trailing-slash URL", () => {
  const canonical = `${origin}/blog/${futureSlug}/`;
  const post = parseBlogPost(futureSource(`canonicalUrl: "${canonical}"\n`));
  assert.equal(post.canonicalUrl, canonical);
  assert.equal(parseBlogPost(futureSource()).canonicalUrl, undefined);
  for (const invalid of [
    canonical.slice(0, -1), `${canonical}/`, `${canonical}?tracking=1`,
    `${canonical}#fragment`, "https://example.com/blog/other/",
  ]) assert.throws(
    () => parseBlogPost(futureSource(`canonicalUrl: "${invalid}"\n`)),
    /canonicalUrl.*trailing-slash/,
  );
});

test("every blog entry and a future entry have identical canonical/social/JSON-LD/sitemap URLs with direct HTTP 200 and bare HTTP 301", async (t) => {
  // Dynamic discovery intentionally includes every article added in the future.
  const posts = [...readBlogPosts(), parseBlogPost(futureSource())];
  const directory = await mkdtemp(path.join(os.tmpdir(), "blog-canonical-parity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "blog"), { recursive: true });
  await writeFile(path.join(directory, "index.html"), "UNCHANGED SPA");
  await writeFile(path.join(directory, "blog/index.html"), renderBlogDocument(posts));
  await writeFile(path.join(directory, "sitemap.xml"), blogSitemap(posts));
  for (const post of posts) {
    await mkdir(path.join(directory, "blog", post.slug), { recursive: true });
    await writeFile(
      path.join(directory, "blog", post.slug, "index.html"),
      renderBlogDocument(posts, post),
    );
  }
  const server = createFrontendApp({ publicDirectory: directory }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sitemapResponse = await fetch(`${base}/sitemap.xml`, { redirect: "manual" });
  assert.equal(sitemapResponse.status, 200);
  const sitemap = await sitemapResponse.text();
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  for (const post of posts) {
    const canonical = `${origin}/blog/${post.slug}/`;
    const pathname = new URL(canonical).pathname;
    assert.equal(locations.filter((location) => location === canonical).length, 1, post.slug);
    assert.ok(!locations.includes(canonical.slice(0, -1)), post.slug);
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(base + pathname, { method, redirect: "manual" });
      assert.equal(response.status, 200, `${method} ${canonical}`);
      assert.equal(response.headers.get("location"), null, canonical);
      assert.equal(response.redirected, false, canonical);
      if (method === "GET") {
        const html = await response.text();
        assert.equal(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1], canonical, post.slug);
        assert.equal(html.match(/<meta property="og:url" content="([^"]+)"/)?.[1], canonical, post.slug);
        assert.equal(html.match(/<meta name="twitter:url" content="([^"]+)"/)?.[1], canonical, post.slug);
        const scripts = [...html.matchAll(/<script id="blog-jsonld" type="application\/ld\+json">([^<]+)<\/script>/g)];
        assert.equal(scripts.length, 1);
        const schema = JSON.parse(scripts[0][1]);
        assert.equal(schema["@type"], "BlogPosting");
        assert.equal(schema.mainEntityOfPage["@id"], canonical, post.slug);
        assert.equal(schema.url, canonical, post.slug);
      } else assert.equal(await response.text(), "");
      const redirect = await fetch(base + pathname.slice(0, -1), {
        method, redirect: "manual",
      });
      assert.equal(redirect.status, 301, `${method} ${pathname.slice(0, -1)}`);
      assert.equal(redirect.headers.get("location"), pathname, post.slug);
    }
  }
  // Index cards, navigation, and article cross-links must not introduce hops.
  for (const post of [undefined, ...posts]) {
    const document = renderBlogDocument(posts, post);
    for (const match of document.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      const url = new URL(match[1], origin);
      if (url.origin !== origin || !/^\/blog(?:\/|$)/.test(url.pathname)) continue;
      assert.ok(url.pathname.endsWith("/"), match[1]);
      assert.equal((await fetch(base + url.pathname, { redirect: "manual" })).status, 200, match[1]);
    }
  }
});
