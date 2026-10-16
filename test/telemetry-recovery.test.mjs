// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

const root = "../artifacts/bitcoin-stratigraphy-dashboard/";
const require = createRequire(new URL(`${root}package.json`, import.meta.url));
const { QueryClient } = require("@tanstack/react-query");
const { renderToStaticMarkup } = require("react-dom/server");
const cache = await tsImport(
  `${root}src/components/command-center/telemetry-cache.ts`,
  import.meta.url,
);
const schemas = await tsImport(
  `${root}src/components/command-center/telemetry-contracts.ts`,
  import.meta.url,
);
const liveData = await tsImport(
  `${root}src/components/command-center/live-data.ts`,
  import.meta.url,
);
const api = await tsImport(
  "../lib/api-client-react/src/generated/api.ts",
  import.meta.url,
);
const storage = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
});

const hash = "a".repeat(64);
const genesisId = "ba4f25dd-7f16-420c-9264-a16f102fd5a6";
const when = "2026-10-16T12:00:00.000Z";
const fixtures = {
  volume: {
    totalSats: 260,
    last24hSats: 0,
    l402Sats: 260,
    nip90Sats: 0,
  },
  stats: {
    verified_toll_sats: 24,
    settled_contracts: 1,
    genesis_escrow_id: genesisId,
  },
  toll: {
    toll_fee_sats: 24,
    target_usd: 0.02,
    btc_usd_price: 82544,
    source: "market",
    quoted_at: when,
  },
  anchor: { merkleRoot: hash, otsStatus: "pending_calendar", updatedAt: when },
  chain: { totalDepth: 422, merkleRoot: hash },
  genesis: {
    create_response: { preimage: "must-not-be-cached" },
    settle_response: {
      status: "SETTLED",
      merkle_root: hash,
      preimage: "must-not-be-cached",
      article_12_receipt: {
        escrow_id: genesisId,
        tree_size: 1,
        leaf_index: 0,
        lightning_settlement: {
          confirmed_at: when,
          preimage: "must-not-be-cached",
        },
      },
    },
  },
  settlements: [
    {
      id: "public-record",
      timestamp: when,
      channel: "L402",
      requestKind: "mcp",
      satsReceived: 250,
      paymentReference: null,
    },
  ],
};
const source = (key, load = async () => fixtures.stats) => ({
  key,
  queryKey: ["telemetry-test", key],
  load,
  parse: (value) => schemas.ledgerStatsSchema.parse(value),
  maxAge: cache.HOUR,
});
const context = () => ({ signal: new AbortController().signal });

test("every telemetry request uses its expected same-origin relative API path", async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    assert.equal(options.method, "GET");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  };
  const signal = new AbortController().signal;
  try {
    await api.getRevenueAnalytics({ signal });
    await api.getEscrowLedgerStats({ signal });
    await api.getEscrowToll({ signal });
    await api.getProvenanceAnchor({ signal });
    await api.getProvenanceChain({ signal });
    await api.getEscrowGenesisReceipt({ signal });
    await api.getRevenueAudit({ limit: 5 }, { signal });
    assert.deepEqual(requests, [
      "/api/v1/analytics/revenue",
      "/api/v1/escrow/stats",
      "/api/v1/escrow/toll",
      "/api/provenance/anchor",
      "/api/provenance/chain",
      "/api/v1/escrow/genesis-receipt",
      "/api/v1/analytics/audit?limit=5",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("all seven public telemetry shapes are accepted; invalid roots/status fail closed", () => {
  for (const [key, schema] of [
    ["volume", schemas.volumeSchema],
    ["stats", schemas.ledgerStatsSchema],
    ["toll", schemas.tollQuoteSchema],
    ["anchor", schemas.anchorSchema],
    ["chain", schemas.chainSchema],
    ["genesis", schemas.genesisSchema],
    ["settlements", schemas.settlementSchema],
  ]) {
    assert.ok(schema.safeParse(fixtures[key]).success, key);
  }
  assert.throws(() =>
    schemas.chainSchema.parse({ totalDepth: 422, merkleRoot: "invalid" }),
  );
  assert.throws(() =>
    schemas.anchorSchema.parse({ ...fixtures.anchor, otsStatus: "confirmed" }),
  );
  assert.throws(() =>
    schemas.ledgerStatsSchema.parse({
      ...fixtures.stats,
      verified_toll_sats: -1,
    }),
  );
});

test("cache restores actual last-good data with its original timestamp, not fabricated defaults", () => {
  const src = source("restore");
  assert.equal(cache.readTelemetrySnapshot(src), undefined);
  const now = Date.now();
  cache.writeTelemetrySnapshot(src, fixtures.stats, now);
  assert.deepEqual(cache.readTelemetrySnapshot(src, now + 1000), {
    data: fixtures.stats,
    updatedAt: now,
  });
  assert.equal(
    cache.readTelemetrySnapshot(src, now + cache.HOUR + 1),
    undefined,
  );
  assert.equal(cache.readTelemetrySnapshot(src, now - 1), undefined);
  const options = cache.telemetryQueryOptions(src);
  assert.equal(options.initialDataUpdatedAt, now);
  assert.equal(options.staleTime, 0, "restored data always revalidates");
});

test("cache excludes payment proofs and tolerates invalid or blocked browser storage", () => {
  const src = {
    key: "genesis",
    parse: (value) => schemas.genesisSchema.parse(value),
    maxAge: cache.HOUR,
  };
  cache.writeTelemetrySnapshot(src, fixtures.genesis);
  const raw = storage.get("bitcoin-stratigraphy:public-telemetry:v1:genesis");
  assert.ok(raw);
  assert.doesNotMatch(raw, /preimage|must-not-be-cached|create_response/);
  assert.equal(
    cache.readTelemetrySnapshot(src).data.settle_response.merkle_root,
    hash,
  );
  storage.set("bitcoin-stratigraphy:public-telemetry:v1:corrupt", "{broken");
  assert.equal(cache.readTelemetrySnapshot(source("corrupt")), undefined);
  storage.set(
    "bitcoin-stratigraphy:public-telemetry:v1:invalid",
    JSON.stringify({ updatedAt: Date.now(), data: {} }),
  );
  assert.equal(cache.readTelemetrySnapshot(source("invalid")), undefined);
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    assert.equal(cache.readTelemetrySnapshot(source("blocked")), undefined);
    assert.deepEqual(
      cache.writeTelemetrySnapshot(source("blocked"), fixtures.stats),
      fixtures.stats,
    );
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  }
});

test("503 keeps cached data and timestamp; subsequent success replaces it", async () => {
  const src = source("recovery");
  const savedAt = Date.now() - 60_000;
  cache.writeTelemetrySnapshot(src, fixtures.stats, savedAt);
  let fail = true;
  src.load = async () => {
    if (fail) throw Object.assign(new Error("temporary"), { status: 503 });
    return { ...fixtures.stats, verified_toll_sats: 48, settled_contracts: 2 };
  };
  const client = new QueryClient();
  const options = { ...cache.telemetryQueryOptions(src), retry: false };
  try {
    // Mount semantics: initialData is installed by the observer / query cache.
    client.setQueryData(src.queryKey, options.initialData, {
      updatedAt: savedAt,
    });
    await assert.rejects(client.fetchQuery(options));
    assert.equal(client.getQueryData(src.queryKey).verified_toll_sats, 24);
    assert.equal(client.getQueryState(src.queryKey).dataUpdatedAt, savedAt);
    fail = false;
    const fresh = await client.fetchQuery(options);
    assert.equal(fresh.verified_toll_sats, 48);
    assert.equal(cache.readTelemetrySnapshot(src).data.verified_toll_sats, 48);
  } finally {
    client.clear();
  }
});

test("temporary retry is bounded and 429 Retry-After blocks poll-driven request bursts", async () => {
  assert.equal(cache.retryTelemetry(0, { status: 503 }), true);
  assert.equal(cache.retryTelemetry(1, { status: 503 }), false);
  for (const status of [400, 401, 404, 429]) {
    assert.equal(cache.retryTelemetry(0, { status }), false);
  }
  assert.equal(cache.telemetryRetryDelay(0, {}), 30_000);
  let requests = 0;
  const error = Object.assign(new Error("rate limit"), {
    status: 429,
    headers: new Headers({ "retry-after": "900" }),
  });
  assert.equal(cache.telemetryRetryDelay(0, error), 900_000);
  const options = cache.telemetryQueryOptions(
    source("cooldown", async () => {
      requests += 1;
      throw error;
    }),
  );
  await assert.rejects(options.queryFn(context()));
  await assert.rejects(options.queryFn(context()));
  assert.equal(requests, 1, "no network retry before the cooldown ends");
});

test("cancellation never overwrites a verified snapshot", async () => {
  const src = source("abort", async (signal) => {
    assert.equal(signal.aborted, true);
    return { ...fixtures.stats, verified_toll_sats: 48 };
  });
  cache.writeTelemetrySnapshot(src, fixtures.stats);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cache.telemetryQueryOptions(src).queryFn({ signal: controller.signal }),
  );
  assert.equal(cache.readTelemetrySnapshot(src).data.verified_toll_sats, 24);
});

function feed(data, extra = {}) {
  return {
    data,
    dataUpdatedAt: Date.now() - 1000,
    isError: false,
    isFetching: false,
    isFetchedAfterMount: true,
    ...extra,
  };
}

test("status never calls missing or restored data Live and uses the oldest reading", () => {
  assert.equal(
    cache.telemetryFeedState([feed(undefined)]).label,
    "Connecting to telemetry",
  );
  assert.equal(cache.telemetryFeedState([feed(undefined)]).updatedAt, 0);
  const restored = feed(fixtures.stats, { isFetchedAfterMount: false });
  assert.equal(cache.telemetryFeedState([restored]).live, false);
  assert.equal(
    cache.telemetryFeedState([restored]).label,
    "Showing last verified readings",
  );
  assert.equal(
    cache.telemetryFeedState([feed(fixtures.stats, { isError: true })]).live,
    false,
  );
  assert.equal(
    cache.telemetryFeedState([
      feed(fixtures.stats, { dataUpdatedAt: 100 }),
      feed(fixtures.chain, { dataUpdatedAt: 200 }),
    ]).updatedAt,
    100,
  );
});

test("all telemetry cards render data, cached fallbacks and calm first-load states", () => {
  const original = readFileSync(
    new URL(
      `${root}src/components/command-center/telemetry-feed.tsx`,
      import.meta.url,
    ),
    "utf8",
  );
  const code = ts.transpileModule(
    original.replaceAll("import.meta.env.BASE_URL", '"/"'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  for (const mode of ["live", "cached", "empty"]) {
    const extra = mode === "cached" ? { isError: true } : {};
    const values = Object.fromEntries(
      Object.entries(fixtures).map(([key, data]) => [
        key,
        feed(
          mode === "empty" ? undefined : data,
          mode === "empty" ? { isError: true } : extra,
        ),
      ]),
    );
    const module = { exports: {} };
    const hookNames = {
      useLightningVolume: "volume",
      useEscrowLedgerStats: "stats",
      useEscrowTollQuote: "toll",
      useProvenanceAnchor: "anchor",
      useProvenanceChain: "chain",
      useGenesisReceipt: "genesis",
      useRecentSettlements: "settlements",
    };
    vm.runInNewContext(code, {
      exports: module.exports,
      module,
      require(path) {
        if (path === "./live-data")
          return Object.fromEntries(
            Object.entries(hookNames).map(([name, key]) => [
              name,
              () => values[key],
            ]),
          );
        if (path === "./telemetry-cache") return cache;
        if (path === "./copy-text-button")
          return { CopyTextButton: () => null };
        if (path === "./format")
          return {
            formatSats: (n) => `${n} sats`,
            formatUsd: String,
            formatUtcDateTime: String,
            formatUtcTime: String,
          };
        return require(path);
      },
    });
    const html = renderToStaticMarkup(
      require("react").createElement(module.exports.TelemetryFeed),
    );
    assert.doesNotMatch(
      html,
      /feeds unavailable|>Unavailable<|> Retry|last refresh failed/,
    );
    for (const id of [
      "metric-lightning-volume",
      "metric-escrow-tolls",
      "metric-ots-status",
      "text-escrow-merkle-root",
      "text-strata-merkle-root",
      "list-recent-settlements",
    ]) {
      assert.ok(html.includes(`data-testid="${id}"`), `${mode}: ${id}`);
    }
    if (mode === "empty") {
      assert.match(html, /Connecting to telemetry/);
      assert.doesNotMatch(html, /24 sats|260 sats/);
    } else {
      assert.match(html, /24 sats/);
      assert.match(html, /260 sats/);
      assert.match(html, /Calendar pending/);
      assert.match(html, /422 verifiable telemetry strata/);
      assert.match(html, new RegExp(hash));
      assert.match(
        html,
        mode === "cached" ? /Showing last verified readings/ : />Live</,
      );
    }
  }
  assert.equal(
    liveData.parseSettlementRecords({ transactions: fixtures.settlements })[0]
      .paymentReference,
    null,
  );
});
