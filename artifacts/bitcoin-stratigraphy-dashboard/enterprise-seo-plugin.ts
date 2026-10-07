import type { Plugin } from "vite";
import {
  ENTERPRISE_DESCRIPTION,
  ENTERPRISE_TITLE,
  ENTERPRISE_URL,
} from "./src/lib/enterprise-seo";

function enterpriseHead(html: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  let result = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escape(ENTERPRISE_TITLE)}</title>`,
  );
  for (const [key, value] of [
    ["description", ENTERPRISE_DESCRIPTION],
    ["og:title", ENTERPRISE_TITLE],
    ["og:description", ENTERPRISE_DESCRIPTION],
    ["twitter:title", ENTERPRISE_TITLE],
    ["twitter:description", ENTERPRISE_DESCRIPTION],
    ["og:url", ENTERPRISE_URL],
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
    `<link rel="canonical" href="${ENTERPRISE_URL}" />`,
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
        return path.endsWith("/enterprise") ? enterpriseHead(html) : html;
      },
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const index = bundle["index.html"];
        if (!index || index.type !== "asset")
          this.error("Missing index.html for enterprise SEO output");
        this.emitFile({
          type: "asset",
          fileName: "enterprise/index.html",
          source: enterpriseHead(String(index.source)),
        });
      },
    },
  };
}
