import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = "artifacts/bitcoin-stratigraphy-dashboard/";
const load = (path) =>
  readFileSync(new URL(`../${root}${path}`, import.meta.url), "utf8");

test("verifier links use the exact label and a base-aware standalone document URL", () => {
  const link = load("src/components/article12-verifier-link.tsx");
  assert.match(link, /<a\s/);
  assert.ok(link.includes("Article 12 Verifier (Zero-Trust)"));
  assert.ok(link.includes("href={`${import.meta.env.BASE_URL}static/verify.html`}"));
  assert.doesNotMatch(link, /onClick=|preventDefault|<Link\b/);
  for (const base of ["/", "/dashboard/"]) {
    for (const page of ["", "enterprise/", "compliance/", "standard/"]) {
      const origin = "https://example.test";
      assert.equal(
        new URL(`${base}static/verify.html`, `${origin}${base}${page}`).href,
        `${origin}${base}static/verify.html`,
      );
    }
  }
  assert.match(load("public/static/verify.html"), /Article 12 receipt verifier/i);
});

test("every main page header and the shared footer expose the verifier", () => {
  for (const file of [
    "App.tsx",
    "pages/enterprise.tsx",
    "pages/compliance.tsx",
    "pages/whitepaper.tsx",
    "pages/standard.tsx",
    "pages/simulator.tsx",
  ]) {
    assert.ok(load(`src/${file}`).includes("<Article12VerifierLink />"), file);
  }
  const footer = load("src/components/site-footer.tsx");
  assert.ok(footer.includes('<Article12VerifierLink placement="footer" />'));
  const app = load("src/App.tsx");
  assert.match(app, /<\/Switch>[\s\S]*<SiteFooter \/>/);
});
