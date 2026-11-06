// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import type { Plugin } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ManifestoContent from "./src/pages/manifesto-content";
import SecurityContent from "./src/pages/security-content";
import {
  SECURITY_ARTICLE, SECURITY_DESCRIPTION, SECURITY_TITLE, SECURITY_URL,
} from "./src/lib/security-seo";
import {
  MANIFESTO_ARTICLE, MANIFESTO_DESCRIPTION, MANIFESTO_TITLE, MANIFESTO_URL,
} from "./src/lib/manifesto-seo";
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
import {
  COMPLIANCE_ARTICLE,
  COMPLIANCE_DESCRIPTION,
  COMPLIANCE_TITLE,
  COMPLIANCE_URL,
} from "./src/lib/compliance-seo";
import {
  ESCROW_APPLICATION, SIMULATOR_DESCRIPTION, SIMULATOR_TITLE, SIMULATOR_URL,
} from "./src/lib/escrow-seo";
import { pageUrl } from "./src/lib/site";

const routes = [
  {
    path: "security",
    title: SECURITY_TITLE,
    description: SECURITY_DESCRIPTION,
    url: SECURITY_URL,
  },
  {
    path: "manifesto",
    title: MANIFESTO_TITLE,
    description: MANIFESTO_DESCRIPTION,
    url: MANIFESTO_URL,
  },
  {
    path: "simulator",
    title: SIMULATOR_TITLE,
    description: SIMULATOR_DESCRIPTION,
    url: SIMULATOR_URL,
  },
  {
    path: "standard",
    title: "API Access & Pricing | Bitcoin Stratigraphy",
    description: "Discover Bitcoin Stratigraphy API access, live L402 micropayment pricing, and commercial licensing for autonomous agents.",
    url: pageUrl("/standard"),
  },
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
  {
    path: "compliance",
    title: COMPLIANCE_TITLE,
    description: COMPLIANCE_DESCRIPTION,
    url: COMPLIANCE_URL,
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
    ["twitter:url", page.url],
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
  result = result.replace(
    /<link\b(?=[^>]*\brel="canonical")[^>]*>/,
    `<link rel="canonical" href="${page.url}" />`,
  );
  if (page.path === "compliance") {
    result = result.replace(
      /<meta\b(?=[^>]*\bproperty="og:type")[^>]*>/,
      '<meta property="og:type" content="article" />',
    );
    const article = JSON.stringify(COMPLIANCE_ARTICLE).replace(/</g, "\\u003c");
    result = result.replace(
      "</head>",
      `<script id="compliance-article-jsonld" type="application/ld+json">${article}</script>\n  </head>`,
    );
  }
  if (page.path === "manifesto" || page.path === "security") {
    const isSecurity = page.path === "security";
    const article = isSecurity ? SECURITY_ARTICLE : MANIFESTO_ARTICLE;
    result = result.replace(
      /<meta\b(?=[^>]*\bproperty="og:type")[^>]*>/,
      '<meta property="og:type" content="article" />',
    );
    result = result.replace(
      "</head>",
      `<script id="${page.path}-article-jsonld" type="application/ld+json">${JSON.stringify(article).replace(/</g, "\\u003c")}</script>\n  </head>`,
    );
    const content = renderToStaticMarkup(createElement(isSecurity ? SecurityContent : ManifestoContent, { base: "/" }));
    result = result.replace('<div id="root"></div>', `<div id="root">${content}</div>`);
  }
  return result;
}

function escrowHead(html: string): string {
  const schema = JSON.stringify({
    "@context": "https://schema.org", ...ESCROW_APPLICATION,
  }).replace(/</g, "\\u003c");
  return html.replace("</script>",
    `</script>\n<script id="escrow-application-jsonld" type="application/ld+json">${schema}</script>`);
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
        return escrowHead(page ? pageHead(html, page) : html);
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
