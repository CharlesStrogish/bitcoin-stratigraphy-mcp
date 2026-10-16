// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

const root = "../artifacts/bitcoin-stratigraphy-dashboard/";
const read = (path) => readFileSync(new URL(root + path, import.meta.url), "utf8");
const { enterpriseSeoPlugin } = await tsImport(
  root + "enterprise-seo-plugin.ts",
  import.meta.url,
);
const metadata = await tsImport(
  root + "src/lib/compliance-seo.ts",
  import.meta.url,
);
const cisoIntake = await tsImport(
  root + "src/lib/ciso-intake.ts",
  import.meta.url,
);
// The interactive intake buttons render client-side; the copy hash covers page text.
function CisoIntakeActions() {
  return null;
}

function renderPage() {
  const source = read("src/pages/compliance.tsx").replace(
    "import.meta.env.BASE_URL",
    '"/"',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compiled, {
    exports,
    require(path) {
      if (path === "react") return { useEffect() {} };
      if (path === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (path === "@/lib/compliance-seo") return metadata;
      if (path === "@/lib/ciso-intake") return cisoIntake;
      if (path === "@/components/ciso-intake-actions") return { CisoIntakeActions };
      if (path.endsWith(".css")) return {};
      throw new Error(`Unexpected dependency: ${path}`);
    },
  });
  return exports.default();
}

function walk(node, visitor) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visitor));
  if (!node || typeof node !== "object") return;
  visitor(node);
  walk(node.props?.children, visitor);
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  return text(node.props?.children);
}

test("compliance marketing copy preserves approved text with live escrow pricing and naming updates", () => {
  const blocks = [];
  walk(renderPage(), (node) => {
    if (["h1", "h2", "p", "li"].includes(node.type)) {
      blocks.push(text(node).replace(/\s+/gu, " ").trim());
    }
  });
  assert.equal(blocks.length, 20);
  assert.equal(
    createHash("sha256").update(blocks.join("\n")).digest("hex"),
    "614a1f548a808aa799c686e811d80fa9865f9cb8facbc172b0f0da03d177f382",
  );
});

test("compliance CTA opens the homepage live escrow terminal and licensing contact uses the CISO intake mailto", () => {
  const links = [];
  const intakeActions = [];
  walk(renderPage(), (node) => {
    if (node.type === "a") links.push(node);
    if (node.type === CisoIntakeActions) intakeActions.push(node);
  });
  assert.equal(
    links.find((node) => text(node).trim() === "Access Live REST Escrow")
      ?.props.href,
    "/#live-escrow-terminal",
  );
  const href = links.find(
    (node) => node.props["data-testid"] === "link-contact-licensing",
  )?.props.href;
  assert.equal(href, cisoIntake.CISO_MAILTO_HREF);
  const mailto = new URL(href);
  assert.equal(mailto.pathname, "licensing@bitcoinstratigraphy.com");
  assert.equal(mailto.searchParams.get("subject"), cisoIntake.CISO_INTAKE_SUBJECT);
  assert.equal(
    mailto.searchParams.get("body"),
    cisoIntake.cisoIntakeTemplate("\r\n"),
  );
  assert.deepEqual(
    intakeActions.map((node) => node.props.testIdPrefix),
    ["compliance"],
  );
});

test("direct compliance HTML includes exact crawler metadata and author JSON-LD", () => {
  const plugin = enterpriseSeoPlugin();
  const html = plugin.transformIndexHtml.handler(read("index.html"), {
    path: "/compliance",
    originalUrl: "/compliance/?view=public",
  });
  assert.ok(html.includes(`<title>${metadata.COMPLIANCE_TITLE}</title>`));
  assert.ok(
    html.includes(
      `<meta name="description" content="${metadata.COMPLIANCE_DESCRIPTION}" />`,
    ),
  );
  assert.ok(
    html.includes(`<link rel="canonical" href="${metadata.COMPLIANCE_URL}" />`),
  );
  const article = JSON.parse(
    html.match(
      /<script id="compliance-article-jsonld" type="application\/ld\+json">([^<]+)<\/script>/,
    )[1],
  );
  assert.equal(article["@type"], "TechArticle");
  assert.equal(article.author.name, "Charles R. Strogish");
  assert.equal(article.url, metadata.COMPLIANCE_URL);
  assert.ok(html.includes('property="og:type" content="article"'));
});

test("homepage metadata stays unchanged and dedicated static pages remain emitted", () => {
  const plugin = enterpriseSeoPlugin();
  const input = read("index.html");
  const home = plugin.transformIndexHtml.handler(input, { path: "/" });
  assert.equal(home.replace(
    /<script id="escrow-application-jsonld" type="application\/ld\+json">[^<]+<\/script>\n/,
    "",
  ), input);
  const emitted = [];
  plugin.generateBundle.handler.call(
    {
      error(message) {
        throw new Error(message);
      },
      emitFile(asset) {
        emitted.push(asset);
      },
    },
    {},
    { "index.html": { type: "asset", source: input } },
  );
  assert.deepEqual(
    emitted.map((asset) => asset.fileName),
    ["simulator/index.html", "standard/index.html", "enterprise/index.html",
      "whitepaper/index.html", "compliance/index.html"],
  );
  for (const asset of emitted) {
    assert.ok(
      asset.source.includes('<link rel="icon" type="image/png" href="/favicon.png" />'),
      `${asset.fileName} preserves the public PNG favicon`,
    );
    for (const token of [
      "gD8puclen7IOEc0MSQGVzV61VebIvL3fn1VRWLVc-BE",
      "gD8puclen7lOEc0MSQGVzV61VeblvL3fn1VRWLVc-BE",
      "5-KfH4O096Z1k7nLsVu8839zUzv8mz0ItthQIGYjC28",
    ]) {
      assert.ok(
        asset.source.includes(
          `<meta name="google-site-verification" content="${token}" />`,
        ),
        `${asset.fileName} preserves verification ${token}`,
      );
    }
  }
  for (const existing of emitted.filter((asset) =>
    ["enterprise/index.html", "whitepaper/index.html"].includes(asset.fileName))) {
    assert.ok(!existing.source.includes('id="compliance-article-jsonld"'));
  }
});
