import type { Plugin } from "vite";
import {
  ENTERPRISE_DESCRIPTION,
  ENTERPRISE_TITLE,
  ENTERPRISE_URL,
} from "./src/lib/enterprise-seo";
import {
  WHITEPAPER_DESCRIPTION,
  WHITEPAPER_TITLE,
  WHITEPAPER_URL,
} from "./src/lib/whitepaper-seo";

const routes = [
  {
    path: "enterprise",
    title: ENTERPRISE_TITLE,
    description: ENTERPRISE_DESCRIPTION,
    url: ENTERPRISE_URL,
  },
  {
    path: "whitepaper",
    title: WHITEPAPER_TITLE,
    description: WHITEPAPER_DESCRIPTION,
    url: WHITEPAPER_URL,
  },
];

function pageHead(html: string, page: (typeof routes)[number]): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  let result = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escape(page.title)}</title>`,
  );
  for (const [key, value] of [
    ["description", page.description],
    ["og:title", page.title],
    ["og:description", page.description],
    ["twitter:title", page.title],
    ["twitter:description", page.description],
    ["og:url", page.url],
  ]) {
    const tag = new RegExp(
      `<meta\\b(?=[^>]*\\b(?:name|property)="${key}")[^>]*>`,
    );
    if (!tag.test(result)) throw new Error(`Missing SEO tag: ${key}`);
    const attribute = key.startsWith("og:") ? "property" : "name";
    result = result.replace(
      tag,
      `<meta ${attribute}="${key}" content="${escape(value)}" />`,
    );
  }
  return result.replace(
    /<link\b(?=[^>]*\brel="canonical")[^>]*>/,
    `<link rel="canonical" href="${page.url}" />`,
  );
}

/** Social crawlers receive route metadata without having to execute React. */
export function enterpriseSeoPlugin(): Plugin {
  return {
    name: "enterprise-route-seo",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const path = (context.originalUrl ?? context.path)
          .split("?")[0]!
          .replace(/\/$/, "");
        const page = routes.find((page) => path.endsWith(`/${page.path}`));
        return page ? pageHead(html, page) : html;
      },
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const index = bundle["index.html"];
        if (!index || index.type !== "asset")
          this.error("Missing index.html for dedicated-page SEO output");
        for (const page of routes) {
          this.emitFile({
            type: "asset",
            fileName: `${page.path}/index.html`,
            source: pageHead(String(index.source), page),
          });
        }
      },
    },
  };
}
