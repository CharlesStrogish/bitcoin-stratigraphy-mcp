// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dashboard = "artifacts/bitcoin-stratigraphy-dashboard";
const commandCenterDir = `${dashboard}/src/components/command-center`;

const app = read(`${dashboard}/src/App.tsx`);
const css = read(`${dashboard}/src/index.css`);
const catalog = read(`${commandCenterDir}/catalog.ts`);
const snippets = read(`${commandCenterDir}/snippets.ts`);
const commandCenter = read(`${commandCenterDir}/command-center.tsx`);
const licensing = read(`${commandCenterDir}/enterprise-licensing-matrix.tsx`);
const pricing = read("artifacts/api-server/src/lib/mcp-pricing.ts");
const serverTools = read("artifacts/api-server/src/routes/mcp.ts");
const publicSite = read("artifacts/api-server/src/lib/public-site.ts");

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const catalogTools = [
  ...catalog.matchAll(/\{\s*name: "([a-z_]+\.[a-z_]+)",\s*title: "([^"]+)"/g),
].map(([, name, title]) => ({ name, title }));

test("command center lists exactly the 16 priced canonical MCP tools", () => {
  const priceTable = pricing.match(
    /export const mcpToolPrices = Object\.freeze\(\{([\s\S]*?)\}\);/,
  );
  assert.ok(priceTable, "server price table found");
  const priced = [...priceTable[1].matchAll(/"([a-z_]+\.[a-z_]+)":/g)]
    .map(([, name]) => name)
    .sort();
  assert.equal(priced.length, 16);
  assert.deepEqual(catalogTools.map((tool) => tool.name).sort(), priced);
  assert.doesNotMatch(catalog, /\bprice\w*\s*:/i, "fees are quoted live");
});

test("command center titles match the server tool registry", () => {
  assert.equal(
    catalogTools.find((tool) => tool.name === "stratigraphy.get")?.title,
    "Get Bitcoin Stratigraphy",
  );
  assert.doesNotMatch(catalog, /Bitooin/);
  for (const { name, title } of catalogTools) {
    const registered = [
      ...serverTools.matchAll(
        new RegExp(`name: "${escape(name)}",\\s*title: "([^"]+)"`, "g"),
      ),
    ].map(([, value]) => value);
    assert.ok(registered.length, `${name} is registered on the server`);
    assert.ok(registered.includes(title), `${name} title matches the server`);
  }
});

test("npx install command matches the published server package", () => {
  const serverPackage = publicSite.match(
    /export const NPM_PACKAGE = "([^"]+)";/,
  );
  assert.ok(serverPackage, "server package constant found");
  assert.match(
    catalog,
    new RegExp(`export const NPM_PACKAGE = "${escape(serverPackage[1])}";`),
  );
  assert.match(
    publicSite,
    /export const NPX_COMMAND = `npx -y \$\{NPM_PACKAGE\}`;/,
  );
  assert.match(
    catalog,
    /export const NPX_INSTALL_COMMAND = `npx -y \$\{NPM_PACKAGE\}`;/,
  );
});

test("framework adapters cover the four frameworks and link to real cookbooks", () => {
  const ids = [...snippets.matchAll(/^\s{4}id: "([a-z]+)",$/gm)].map(
    ([, id]) => id,
  );
  assert.deepEqual(ids, ["langchain", "llamaindex", "crewai", "autogen"]);
  const paths = [
    ...snippets.matchAll(/(?:path|file): "(cookbooks\/[^"]+)"/g),
  ].map(([, path]) => path);
  assert.ok(paths.length >= 8, "every adapter links its cookbook");
  for (const path of new Set(paths)) {
    assert.ok(
      existsSync(new URL(`../${path}`, import.meta.url)),
      `${path} exists`,
    );
  }
  for (const cookbook of [
    "cookbooks/frameworks/langchain_agent.py",
    "cookbooks/frameworks/llamaindex_agent.py",
  ]) {
    const source = read(cookbook);
    assert.match(
      source,
      /"X-L402-Batch-Size": "100"/,
      `${cookbook} batch header`,
    );
    assert.match(source, /L402_AUTHORIZATION/, `${cookbook} credential secret`);
  }
  assert.equal(
    snippets.match(/"X-L402-Batch-Size": "100"/g)?.length,
    2,
    "only the native MCP adapters send the batch header",
  );
});

test("static enterprise licensing replaces the removed telemetry module", () => {
  assert.match(
    commandCenter,
    /<McpToolsMatrix \/>\s*<EnterpriseLicensingMatrix \/>\s*<FrameworkAdapters \/>/,
  );
  assert.doesNotMatch(commandCenter, /TelemetryFeed|Merkle telemetry/);
  assert.match(licensing, /Enterprise Licensing &amp; Compliance Architecture/);
  assert.doesNotMatch(
    licensing,
    /useQuery|useEffect|fetch\(|@workspace\/api-client|\.\/live-data|Unavailable/,
  );
  for (const file of [
    "telemetry-feed.tsx",
    "telemetry-cache.ts",
    "telemetry-contracts.ts",
  ]) {
    assert.equal(
      existsSync(new URL(`../${commandCenterDir}/${file}`, import.meta.url)),
      false,
      `${file} is removed, not merely hidden`,
    );
  }
});

test("homepage keeps CSV and PDF together in a balanced responsive action grid", () => {
  assert.match(app, /className="header-actions homepage-actions"/);
  const exports = app.match(
    /<div\s+className="header-exports"\s+role="group"\s+aria-label="Export options"\s*>([\s\S]*?)<\/div>/,
  );
  assert.ok(exports, "exports share one grid cell");
  assert.match(exports[1], /onClick=\{onExport\}/);
  assert.match(exports[1], /onClick=\{\(\) => window\.print\(\)\}/);
  assert.match(exports[1], /> CSV/);
  assert.match(exports[1], /> PDF/);
  assert.equal(exports[1].match(/<button/g)?.length, 2);
  assert.match(
    css,
    /\.header-actions\.homepage-actions\s*\{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    css,
    /@media \(max-width: 767px\)\s*\{\s*\.header-actions\.homepage-actions\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    css,
    /\.live-escrow-section > \[data-testid="link-compliance-guide"\]\s*\{[^}]*margin: 20px 0 16px/,
  );
});

test("homepage polling leaves most of the public rate budget to the visitor", () => {
  const limiter = read("artifacts/api-server/src/middleware/rateLimiter.ts");
  const liveData = read(`${commandCenterDir}/live-data.ts`);
  const terminal = read(
    `${dashboard}/src/simulator/components/EscrowTerminal.tsx`,
  );
  const minutes = (source, name) => {
    const match = source.match(new RegExp(`${name} = (\\d+) \\* 60_000;`));
    assert.ok(match, `${name} is declared in minutes`);
    return Number(match[1]) * 60_000;
  };
  const limit = Number(limiter.match(/PUBLIC_RATE_LIMIT = (\d+);/)?.[1]);
  const windowMs = minutes(limiter, "PUBLIC_RATE_WINDOW_MS");
  const terminalMs = Number(
    terminal
      .match(/setInterval\(\(\) => void refresh\(\), ([\d_]+)\)/)?.[1]
      .replaceAll("_", ""),
  );
  assert.ok(limit > 0 && terminalMs > 0, "rate budget inputs found");
  // Each poller fetches once on mount, then once per elapsed interval.
  const perWindow = (pollers, intervalMs) =>
    pollers * (Math.ceil(windowMs / intervalMs) + 1);
  assert.doesNotMatch(
    liveData,
    /refetchInterval|getRevenueAnalytics|getRevenueAudit|getProvenance|genesis-receipt|getEscrowLedgerStats|getEscrowToll/,
    "Command Center no longer mounts any database-backed telemetry pollers",
  );
  const oneShotReads = 1; // Free MCP price discovery; licensing is static.
  const used = perWindow(1, terminalMs) + oneShotReads;
  assert.ok(used <= limit * 0.6, `${used} of ${limit} requests per window`);
});

test("legacy video-archive UI is removed while the hero and escrow stay", () => {
  for (const legacy of [
    "Search the strata",
    "Series index",
    "How the framing moves",
    "Title-signal breakdown",
    "FilterRail",
    "TableCard",
    "Insights",
    "recharts",
    "StatCard",
    "stats-row",
    "INDEXED ENTRIES",
    "STRATA SPAN",
    "10M SIGNAL",
    "SERIES COMPLETION",
    "records in view",
    "Uploaded JSON",
    "planned day layers",
    "source-badge",
  ]) {
    assert.ok(!app.includes(legacy), `${legacy} is gone from the homepage`);
  }
  for (const selector of [
    ".filter-rail",
    ".table-card",
    ".insights-grid",
    ".workspace-grid",
  ]) {
    assert.ok(!css.includes(selector), `${selector} styles are gone`);
  }
  assert.match(app, /Bitcoin <span>Stratigraphy<\/span>/);
  assert.match(app, /<TrustBadges \/>/);
  assert.match(app, /<EscrowTerminal \/>/);
  assert.match(
    app,
    /import \{ CommandCenter \} from "@\/components\/command-center\/command-center";/,
  );
});
