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

function loadComponent(componentSource) {
  const code = ts.transpileModule(componentSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (path) => {
      if (path.endsWith(".css")) return {};
      if (path === "./waiver-purchase") {
        // The CommonJS sandbox has no import.meta; pin the base path to "/".
        return loadComponent(
          readFileSync(
            new URL(
              `${root}src/components/command-center/waiver-purchase.tsx`,
              import.meta.url,
            ),
            "utf8",
          ).replaceAll("import.meta.env.BASE_URL", '"/"'),
        );
      }
      if (path === "./copy-text-button") {
        return loadComponent(
          readFileSync(
            new URL(
              `${root}src/components/command-center/copy-text-button.tsx`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      }
      return require(path);
    },
    fetch: () => {
      assert.fail("The licensing matrix must not make network requests");
    },
  });
  return module.exports;
}

function renderMatrix() {
  return require("react-dom/server").renderToStaticMarkup(
    require("react").createElement(
      loadComponent(source).EnterpriseLicensingMatrix,
    ),
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
    "02 · DUAL-LICENSING & COMPLIANCE MATRIX",
    "Community Open Source",
    "AGPLv3 License",
    "Public Network Node",
    "Standard Tool Access",
    "AGPLv3 Commercial Copyright Waiver",
    "Time-Locked AGPLv3 Section 13 Waiver",
    "Self-Hosted Air-Gapped / VPC Deployment",
    "EU AI Act Article 12 & 26(6) Tamper-Evident Flight Recorders",
    "L402 Runaway Swarm Circuit Breakers",
    "Cryptographically Signed Tool Integrity",
    "Ed25519-Signed Waiver Certificate, Verifiable Offline",
  ]) {
    assert.ok(text.includes(label), `renders ${label}`);
  }
  assert.match(text, /From\s*\$2,500\s*\/30 days in BTC/);
  // Superseded commercial/SLA offers are gone.
  assert.doesNotMatch(text, /Automated Compliance SLAs|\$250k|Tier II|licensing@bitcoinstratigraphy\.com/);
  assert.equal((html.match(/<article\b/g) ?? []).length, 2);
  assert.equal((html.match(/<li\b/g) ?? []).length, 9);
  assert.doesNotMatch(
    text,
    /Unavailable|MAINNET SATS ACCRUED|RECENT VERIFIED SETTLEMENTS|Live Cryptographic/,
  );
});

test("licensing links the public integrity manifest below the tier matrix", () => {
  const html = renderMatrix();
  const enterprise = html.match(/<article\b[^>]*data-testid="card-tier-enterprise"[\s\S]*?<\/article>/)?.[0];
  assert.match(enterprise ?? "", /<li>Cryptographically Signed Tool Integrity<\/li>/);
  assert.match(
    html,
    /<\/details><\/div><a class="elm-integrity-link" href="\/\.well-known\/integrity\.json" data-testid="link-tool-integrity-manifest">View Tool Integrity Manifest<\/a>/,
  );
  assert.doesNotMatch(source, /useEffect|useQuery|fetch\(/);
});

test("CISO risk brief is expandable below the waiver tier with a working procurement anchor", () => {
  const html = renderMatrix();
  assert.match(html, /<section[^>]*id="enterprise-licensing"/);
  assert.match(html, /<\/article><details class="elm-risk-brief" data-testid="ciso-vendor-risk-brief"><summary>CISO Vendor Risk &amp; AGPLv3 Copyleft Brief<\/summary>/);
  assert.ok(html.includes("/api/v1/compliance/revocation-snapshot"));
  assert.ok(html.includes("current and historical public keys"));
  assert.ok(html.includes("AGPLv3 Section 13"));
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

const DISCLOSURE =
  "All prepaid MCP Macro-Macaroons, Scanner Packs, and AGPLv3 Commercial Copyright Waivers are 100% self-serve and provided STRICTLY AS-IS, WITH ALL FAULTS. Zero SLAs, zero uptime warranties, zero indemnity, zero custom MSAs, zero vendor questionnaires, and zero support obligations. Full source code is publicly inspectable under AGPLv3 for independent self-hosting. Payment for a Commercial Copyright Waiver strictly grants a time-locked, non-negotiable waiver from AGPLv3 Section 13 network source-disclosure requirements for the specified term, anchored cryptographically to your confirmed Bitcoin transaction.";

test("licensing uses the shared module kicker and shows the verbatim AS-IS disclosure", () => {
  const html = renderMatrix();
  assert.match(
    html,
    /class="section-kicker">02 · DUAL-LICENSING &amp; COMPLIANCE MATRIX/,
  );
  assert.doesNotMatch(html, /elm-kicker-index|Module 02/);
  assert.match(html, /data-testid="text-waiver-disclosure">([^<]*)</);
  const shown = html.match(/data-testid="text-waiver-disclosure">([^<]*)</)[1];
  assert.equal(shown, DISCLOSURE);
  assert.doesNotMatch(html, /data-testid="(?:button-copy-licensing-email|link-enterprise-licensing-intake)"/);
});

test("self-serve waiver form offers all four tiers and gates quoting on exact terms acceptance", () => {
  const html = renderMatrix();
  assert.match(html, /<section[^>]*aria-labelledby="cc-licensing-title"/);
  assert.match(html, /<h3 id="cc-licensing-title">/);
  for (const tier of ["swarm_monthly", "swarm_annual", "global_monthly", "global_annual"]) {
    assert.match(html, new RegExp(`data-testid="radio-waiver-${tier}"`));
  }
  for (const price of ["$2,500", "$25,000", "$250,000"]) assert.ok(html.includes(price));
  assert.match(html, /<input type="checkbox"[^>]*data-testid="checkbox-terms-accepted"/);
  assert.doesNotMatch(html, /data-testid="checkbox-terms-accepted"[^>]*checked/);
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*data-testid="button-waiver-quote"/);
  assert.match(html, /data-testid="input-licensee-name"/);
  assert.match(html, /data-testid="input-licensee-identifier"/);
  const waiver = readFileSync(
    new URL(`${root}src/components/command-center/waiver-purchase.tsx`, import.meta.url),
    "utf8",
  );
  assert.match(waiver, /"api\/v1\/waivers\/quote"/);
  assert.match(waiver, /"api\/v1\/waivers\/claim"/);
  assert.match(waiver, /terms_accepted: accepted === true/);
  assert.match(waiver, /static\/verify\.html/);
  assert.doesNotMatch(waiver, /localhost/);
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
