import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import test from "node:test";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(
  await readFile(
    new URL("../../../.well-known/ai-plugin.json", import.meta.url),
    "utf8",
  ),
);
const source = await readFile(
  new URL("../src/lib/agent-seo.tsx", import.meta.url),
  "utf8",
);
const compiled = await transformWithEsbuild(source, "agent-seo.tsx", {
  loader: "tsx",
  format: "cjs",
  jsx: "transform",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.code)(
  (id) => (id.endsWith("ai-plugin.json") ? manifest : require(id)),
  module,
  module.exports,
);
const { AGENT_DISCOVERY, AGENT_STRUCTURED_DATA, AgentDiscoveryContent } =
  module.exports;

test("agent catalog lists all 19 canonical tools with accurate payment scopes", () => {
  const names = AGENT_DISCOVERY.tools.map((tool) => tool.name);
  assert.equal(names.length, 19);
  assert.equal(new Set(names).size, 19);
  assert.deepEqual(
    names.filter((name) => name.startsWith("clearing.")),
    ["clearing.create_contract", "clearing.settle_contract"],
  );
  assert.equal(
    AGENT_DISCOVERY.tools.filter((tool) => tool.access === "l402").length,
    14,
  );
  assert.deepEqual(
    AGENT_DISCOVERY.tools
      .filter((tool) => tool.access === "free")
      .map((tool) => tool.name),
    ["stratigraphy.list", "proof.list"],
  );
  assert.equal(AGENT_DISCOVERY.payments.l402.standard_sats_per_paid_call, 250);
  assert.equal(AGENT_DISCOVERY.api_base_url, "https://bitcoinstratigraphy.com");
  assert.equal(
    manifest.api.url,
    "https://bitcoinstratigraphy.com/openapi.json",
  );
});

test("SoftwareApplication and Product JSON-LD separate MCP access from scanner credits", () => {
  assert.equal(AGENT_STRUCTURED_DATA["@context"], "https://schema.org");
  const graph = AGENT_STRUCTURED_DATA["@graph"];
  const software = graph.find(
    (entry) => entry["@type"] === "SoftwareApplication",
  );
  const product = graph.find((entry) => entry["@type"] === "Product");
  assert.equal(software.featureList.length, 19);
  assert.equal(software.offers.price, "0.00000250");
  assert.equal(software.offers.priceCurrency, "BTC");
  assert.equal(product.name, "$500 Enterprise API Block");
  assert.equal(product.offers[0].price, "500.00");
  assert.equal(product.offers[0].priceCurrency, "USD");
  assert.match(product.offers[0].acceptedPaymentMethod, /Credit card.*Stripe/);
  assert.equal(product.offers.length, 1);
  for (const offer of product.offers) assert.equal(offer.priceCurrency, "USD");
  assert.match(product.description, /100 prepaid heuristic scanner calls/);
  assert.match(product.description, /30 days/);
  assert.match(product.description, /do not authorize unrelated MCP tools/);
});

test("Product declares a real image and digital service without invented reviews or shipping", async () => {
  const product = AGENT_STRUCTURED_DATA["@graph"].find(
    (entry) => entry["@type"] === "Product",
  );
  assert.equal(product.image, "https://bitcoinstratigraphy.com/og-image.png");
  const image = await readFile(new URL("../public/og-image.png", import.meta.url));
  assert.equal(image.subarray(1, 4).toString(), "PNG");
  assert.equal(product.additionalType, "https://schema.org/Service");
  assert.match(product.category, /Digital service/);
  const check = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!["review", "aggregateRating", "shippingDetails", "hasMerchantReturnPolicy"].includes(key), key);
      check(child);
    }
  };
  check(product);
  assert.deepEqual(JSON.parse(JSON.stringify(AGENT_STRUCTURED_DATA)), AGENT_STRUCTURED_DATA);
});

test("all tools and prices are plain initial HTML, accessible without changing layout", () => {
  const html = renderToStaticMarkup(createElement(AgentDiscoveryContent));
  for (const { name } of AGENT_DISCOVERY.tools)
    assert.ok(html.includes(`<dt>${name}</dt>`), name);
  assert.match(html, /250 sats\/call/);
  assert.match(html, /\$500 USD/);
  assert.match(html, /100,000 sats/);
  assert.match(html, /100 prepaid heuristic scanner calls, 30 days/);
  assert.match(html, /aria-label="Agent API catalog and payment options"/);
  assert.match(html, /position:absolute/);
  assert.doesNotMatch(html, /display:none|aria-hidden|<script|<iframe/);
  for (const link of html.match(/<a\b[^>]*>/g) ?? []) {
    assert.ok(
      link.includes('tabindex="-1"'),
      "clipped links must not add invisible keyboard tab stops",
    );
  }
  assert.doesNotMatch(
    source,
    /api-client-react|use-prepaid|fiat-mint-checkout|\.css["']/,
  );
});

test("both llms documents enumerate the catalog and preserve funding guardrails", async () => {
  for (const relative of [
    "../public/llms.txt",
    "../../api-server/src/public/.well-known/llms.txt",
  ]) {
    const guide = await readFile(new URL(relative, import.meta.url), "utf8");
    for (const { name } of AGENT_DISCOVERY.tools)
      assert.ok(guide.includes(`\`${name}\``), `${relative}: ${name}`);
    assert.match(guide, /250 sats\/call/);
    assert.match(guide, /\$500 Enterprise API Block/);
    assert.match(guide, /100 prepaid heuristic scanner calls/);
    assert.match(guide, /30 days/);
    assert.match(guide, /https:\/\/bitcoinstratigraphy\.com\/api/);
  }
});
