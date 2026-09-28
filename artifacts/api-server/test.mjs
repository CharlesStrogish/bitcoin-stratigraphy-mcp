import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";

process.env.NOSTR_PRIVATE_KEY ??= "01".padStart(64, "0");
process.env.NODE_ENV = "test";

const outputs = [
  "./dist/provenancePersistence.unit.test.js",
  "./dist/stratigraphy.contract.test.js",
  "./dist/pricing.test.js",
  "./dist/settlement_redundancy.test.js",
  "./dist/coinos-uuid-settlement.test.js",
  "./dist/stream.test.js",
  "./dist/nostrAttestation.test.js",
  "./dist/agentReputation.test.js",
  "./dist/multiSettlement.test.js",
  "./dist/zkProof.test.js",
  "./dist/zkDrift.test.js",
  "./dist/zkDriftRoute.test.js",
  "./dist/meshGossip.test.js",
  "./dist/dvm.test.js",
  "./dist/l402.test.js",
  "./dist/announcer.test.js",
  "./dist/ledger.test.js",
  "./dist/orchestrator.test.js",
  "./dist/epistemicGrounding.test.js",
  "./dist/otsProvenance.test.js",
];

const provenancePersistenceTest = `
import test from "node:test";
import assert from "node:assert/strict";
import { persistProvenancePrefix } from "./src/services/provenancePersistence.ts";

const genesis = "0".repeat(64);
function stratum(day, hash, prevHash) {
  return { day, stratumHash: hash.repeat(64).slice(0, 64), prevHash };
}
function makePool(initial = []) {
  const state = { rows: [...initial], inserts: 0, locks: 0, failSelect: false };
  return {
    state,
    async connect() {
      let transactionRows = [...state.rows];
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN") transactionRows = [...state.rows];
          else if (sql.startsWith("SELECT pg_advisory_xact_lock")) state.locks += 1;
          else if (sql.startsWith("SELECT day,")) {
            if (state.failSelect) throw new Error("database unavailable");
            return { rows: [...transactionRows] };
          } else if (sql.startsWith("INSERT INTO stratigraphy_provenance_strata")) {
            state.inserts += 1;
            transactionRows.push({
              day: values[0],
              stratum_hash: values[1],
              prev_hash: values[2],
            });
          } else if (sql === "COMMIT") state.rows = transactionRows;
          else if (sql === "ROLLBACK") transactionRows = [...state.rows];
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}
const first = stratum(1, "a", genesis);
const second = stratum(2, "b", first.stratumHash);
const third = stratum(3, "c", second.stratumHash);

test("bootstraps an empty ledger then appends only the new suffix", async () => {
  const pool = makePool();
  await persistProvenancePrefix([first], pool);
  await persistProvenancePrefix([first, second, third], pool);
  assert.deepEqual(pool.state.rows.map((row) => row.day), [1, 2, 3]);
  assert.equal(pool.state.inserts, 3);
  assert.equal(pool.state.locks, 2);
});

test("rejects historical rewrites, truncation, and candidate gaps", async () => {
  const pool = makePool([
    { day: 1, stratum_hash: first.stratumHash, prev_hash: genesis },
    { day: 2, stratum_hash: second.stratumHash, prev_hash: first.stratumHash },
  ]);
  await assert.rejects(
    persistProvenancePrefix([first, stratum(2, "d", first.stratumHash)], pool),
    /rewrites immutable day 2/,
  );
  await assert.rejects(persistProvenancePrefix([first], pool), /truncates stored history/);
  await assert.rejects(
    persistProvenancePrefix([first, { ...second, day: 3 }], pool),
    /invalid or gapped candidate/,
  );
  assert.equal(pool.state.inserts, 0);
});

test("fails closed on database errors without committing changes", async () => {
  const pool = makePool();
  pool.state.failSelect = true;
  await assert.rejects(persistProvenancePrefix([first], pool), /database unavailable/);
  assert.deepEqual(pool.state.rows, []);
});
`;

await build({
  stdin: {
    contents: provenancePersistenceTest,
    resolveDir: process.cwd(),
    sourcefile: "provenancePersistence.unit.test.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: true,
  outfile: "./dist/provenancePersistence.unit.test.js",
});

await build({
  entryPoints: {
    "stratigraphy.contract.test": "./src/routes/stratigraphy.contract.test.ts",
    "pricing.test": "./tests/unit/pricing.test.ts",
    "settlement_redundancy.test":
      "./tests/unit/settlement_redundancy.test.ts",
    "coinos-uuid-settlement.test":
      "./tests/unit/coinos-uuid-settlement.test.ts",
    "stream.test": "./tests/unit/stream.test.ts",
    "nostrAttestation.test": "../../tests/nostrAttestation.test.ts",
    "agentReputation.test": "../../tests/agentReputation.test.ts",
    "multiSettlement.test": "../../tests/multiSettlement.test.ts",
    "zkProof.test": "../../tests/zkProof.test.ts",
    "zkDrift.test": "./tests/zkDrift.test.ts",
    "zkDriftRoute.test": "./src/routes/zk-drift.test.ts",
    "meshGossip.test": "../../tests/meshGossip.test.ts",
    "provenanceChain.test": "../../tests/provenanceChain.test.ts",
    "provenanceRoutes.test": "./src/routes/provenance.test.ts",
    "dvm.test": "./tests/unit/dvm.test.ts",
    "l402.test": "../../tests/l402.test.ts",
    "announcer.test": "../../tests/announcer.test.ts",
    "ledger.test": "../../tests/ledger.test.ts",
    "orchestrator.test": "../../tests/orchestrator.test.ts",
    "epistemicGrounding.test": "../../tests/epistemicGrounding.test.ts",
    "otsProvenance.test": "./tests/unit/otsProvenance.test.ts",
  },
  outdir: "./dist",
  bundle: true,
  platform: "node",
  format: "esm",
  loader: { ".yaml": "text" },
  external: [
    "express",
    "@getalby/sdk",
    "nostr-tools",
    "yaml",
    "snarkjs",
    "poseidon-lite",
  ],
  banner: {
    js: `import { createRequire as __testCreateRequire } from "node:module";
import __testPath from "node:path";
import { fileURLToPath as __testFileURLToPath } from "node:url";
const require = __testCreateRequire(import.meta.url);
globalThis.__filename = __testFileURLToPath(import.meta.url);
globalThis.__dirname = __testPath.dirname(globalThis.__filename);`,
  },
  sourcemap: "inline",
});
await cp("./src/services/zk/artifacts", "./dist/zk/artifacts", {
  recursive: true,
});

const { spawnSync } = await import("node:child_process");
const results = outputs.map((output) =>
  spawnSync(process.execPath, ["--test", output], {
    stdio: "inherit",
  }),
);

await Promise.all([
  ...outputs.map((output) => rm(output, { force: true })),
  rm("./dist/zk", { recursive: true, force: true }),
]);
process.exitCode = results.some((result) => result.status !== 0) ? 1 : 0;