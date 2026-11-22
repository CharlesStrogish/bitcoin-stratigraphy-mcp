import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Plugin } from "vite";
import BlogContent, { type BlogPost } from "./src/pages/blog-content";
import { readBlogPosts } from "./blog/content";
import { pageUrl, siteUrl } from "./src/lib/site";

export const BLOG_TITLE =
  "Enterprise AI & Bitcoin Engineering Blog | Bitcoin Stratigraphy";
export const BLOG_DESCRIPTION =
  "Engineering notes on autonomous AI agents, enterprise audit evidence, MCP integrations, and Bitcoin payment infrastructure.";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function blogSchema(post?: BlogPost) {
  const publisher = {
    "@type": "Organization",
    name: "Bitcoin Stratigraphy",
    url: siteUrl("/"),
  };
  if (!post)
    return {
      "@context": "https://schema.org",
      "@type": "Blog",
      name: BLOG_TITLE,
      description: BLOG_DESCRIPTION,
      url: pageUrl("/blog"),
      publisher,
    };
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: `${post.date}T00:00:00Z`,
    ...(post.dateModified
      ? { dateModified: `${post.dateModified}T00:00:00Z` }
      : {}),
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": post.canonicalUrl ?? pageUrl(`/blog/${post.slug}`),
    },
    url: post.canonicalUrl ?? pageUrl(`/blog/${post.slug}`),
    ...(post.schemaKeywords ? { keywords: post.schemaKeywords } : {}),
    author: post.authorName
      ? {
          "@type": "Person",
          name: post.authorName,
          ...(post.authorUrl ? { url: post.authorUrl } : {}),
        }
      : publisher,
    publisher: {
      ...publisher,
      ...(post.publisherLogo
        ? { logo: { "@type": "ImageObject", url: post.publisherLogo } }
        : {}),
    },
    inLanguage: "en",
    isPartOf: { "@type": "Blog", "@id": pageUrl("/blog") },
  };
}

/** A standalone document deliberately excludes the SPA and payment-client bundle. */
export function renderBlogDocument(
  posts: BlogPost[],
  post?: BlogPost,
  base = "/",
) {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const title = post?.title ?? BLOG_TITLE;
  const description = post?.description ?? BLOG_DESCRIPTION;
  const canonical =
    post?.canonicalUrl ?? pageUrl(post ? `/blog/${post.slug}` : "/blog");
  const css = readFileSync(
    new URL("./src/pages/blog.css", import.meta.url),
    "utf8",
  );
  const json = JSON.stringify(blogSchema(post)).replace(/</g, "\\u003c");
  const image = siteUrl("/og-image.png");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${post?.keywords ? `<meta name="keywords" content="${escapeHtml(post.keywords.join(", "))}">` : ""}
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="${prefix}favicon.png">
<link rel="icon" type="image/x-icon" sizes="16x16 32x32 48x48 64x64 128x128" href="${prefix}favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="${prefix}favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="${prefix}favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="${prefix}apple-touch-icon.png">
<link rel="mask-icon" href="${prefix}safari-pinned-tab.svg" color="#D4AF37">
<link rel="manifest" href="${prefix}site.webmanifest">
<meta name="theme-color" content="#0B0F19">
<meta name="msapplication-TileColor" content="#0B0F19">
<meta name="msapplication-TileImage" content="${prefix}mstile-150x150.png">
<meta name="msapplication-config" content="${prefix}browserconfig.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&amp;family=Space+Grotesk:wght@400;500;600;700&amp;display=swap">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="${post ? "article" : "website"}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image}">
<meta property="og:site_name" content="Bitcoin Stratigraphy">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:url" content="${canonical}">
<meta name="twitter:image" content="${image}">
${post ? `<meta property="article:published_time" content="${post.date}T00:00:00Z">` : ""}
${post?.dateModified ? `<meta property="article:modified_time" content="${post.dateModified}T00:00:00Z">` : ""}
<script id="blog-jsonld" type="application/ld+json">${json}</script>
<style>${css}</style></head>
<body class="blog-document">${renderToStaticMarkup(createElement(BlogContent, { posts, post, base: prefix }))}</body></html>`;
}

export function blogSitemap(posts: BlogPost[]) {
  const original = readFileSync(
    new URL("./public/sitemap.xml", import.meta.url),
    "utf8",
  );
  const entries = [
    `<url><loc>${pageUrl("/blog")}</loc></url>`,
    ...posts.map(
      (post) =>
        `<url><loc>${post.canonicalUrl ?? pageUrl(`/blog/${post.slug}`)}</loc><lastmod>${post.dateModified ?? post.date}</lastmod></url>`,
    ),
  ].join("\n");
  return original.replace("</urlset>", `${entries}\n</urlset>`);
}

export function blogPlugin(): Plugin {
  let base = "/";
  return {
    name: "static-markdown-blog",
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const prefix = base.replace(/\/$/, "");
        const route = url.pathname.slice(prefix.length);
        if (!url.pathname.startsWith(`${prefix}/`)) return next();
        const isBlog = route === "/blog" || route.startsWith("/blog/");
        if (!isBlog && route !== "/sitemap.xml") return next();
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          return res.end();
        }
        try {
          const posts = readBlogPosts();
          if (route === "/sitemap.xml") {
            res.setHeader("Content-Type", "application/xml; charset=utf-8");
            return res.end(
              req.method === "HEAD" ? undefined : blogSitemap(posts),
            );
          }
          const normalized = route.replace(/\/$/, "");
          const post = posts.find(
            (entry) => normalized === `/blog/${entry.slug}`,
          );
          if (normalized !== "/blog" && !post) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.end(
              req.method === "HEAD"
                ? undefined
                : `<!doctype html><html lang="en"><head><meta name="robots" content="noindex"><title>Article not found</title></head><body><h1>Article not found</h1><a href="${base}blog/">Back to blog</a></body></html>`,
            );
          }
          if (!route.endsWith("/")) {
            res.statusCode = 301;
            res.setHeader("Location", `${url.pathname}/${url.search}`);
            return res.end();
          }
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            req.method === "HEAD"
              ? undefined
              : renderBlogDocument(posts, post, base),
          );
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle() {
      const posts = readBlogPosts();
      this.emitFile({
        type: "asset",
        fileName: "blog/index.html",
        source: renderBlogDocument(posts, undefined, base),
      });
      for (const post of posts) {
        this.emitFile({
          type: "asset",
          fileName: `blog/${post.slug}/index.html`,
          source: renderBlogDocument(posts, post, base),
        });
      }
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: blogSitemap(posts),
      });
    },
  };
}
