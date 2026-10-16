// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = "../artifacts/bitcoin-stratigraphy-dashboard/";
const require = createRequire(new URL(`${root}package.json`, import.meta.url));
const source = readFileSync(
  new URL(
    `${root}src/components/command-center/enterprise-licensing-matrix.tsx`,
    import.meta.url,
  ),
  "utf8",
);

function renderMatrix() {
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (path) => (path.endsWith(".css") ? {} : require(path)),
    fetch: () => {
      assert.fail("The licensing matrix must not make network requests");
    },
  });
  return require("react-dom/server").renderToStaticMarkup(
    require("react").createElement(module.exports.EnterpriseLicensingMatrix),
  );
}

test("licensing renders both tiers with every requested entitlement and price", () => {
  const html = renderMatrix();
  const text = html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"');
  for (const label of [
    "Enterprise Licensing & Compliance Architecture",
    "The Dual-Licensing & Compliance Matrix",
    "Community Open Source",
    "AGPLv3 License",
    "Public Network Node",
    "Standard Tool Access",
    "Commercial Enterprise Exemption",
    "Proprietary IP Shield / No Viral Copyleft",
    "Air-Gapped / VPC Deployment",
    "EU AI Act Article 12 & 26(6) Tamper-Evident Flight Recorders",
    "L402 Runaway Swarm Circuit Breakers",
    '"AS IS" No-SLA delivery',
  ]) {
    assert.ok(text.includes(label), `renders ${label}`);
  }
  assert.match(text, /Starting at\s*\$250k\s*\/Annual/);
  assert.equal((html.match(/<article\b/g) ?? []).length, 2);
  assert.equal((html.match(/<li\b/g) ?? []).length, 8);
  assert.doesNotMatch(
    text,
    /Unavailable|MAINNET SATS ACCRUED|RECENT VERIFIED SETTLEMENTS|Live Cryptographic/,
  );
});

test("enterprise intake is a prominent accessible email link to licensing", () => {
  const html = renderMatrix();
  assert.match(html, /<section[^>]*aria-labelledby="cc-licensing-title"/);
  assert.match(html, /<h3 id="cc-licensing-title">/);
  const link = html.match(
    /<a\b[^>]*data-testid="link-enterprise-licensing-intake"[^>]*>/,
  )?.[0];
  assert.ok(link, "intake link is present");
  const href = link.match(/href="([^"]+)"/)?.[1];
  assert.ok(href);
  const mailto = new URL(href);
  assert.equal(mailto.protocol, "mailto:");
  assert.equal(mailto.pathname, "licensing@bitcoinstratigraphy.com");
  assert.equal(
    mailto.searchParams.get("subject"),
    "CISO Enterprise Licensing Intake",
  );
  assert.match(html, /Request enterprise licensing/);
});

test("licensing has responsive containment and keyboard focus styles", () => {
  const css = readFileSync(
    new URL(
      `${root}src/components/command-center/enterprise-licensing-matrix.css`,
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(css, /\.elm-grid\s*\{[^}]*grid-template-columns:/);
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.elm-grid\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/,
  );
  assert.match(css, /\.elm-cta:focus-visible/);
  assert.match(css, /overflow-wrap: anywhere/);
});
