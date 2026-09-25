import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";

process.env.NOSTR_PRIVATE_KEY ??= "01".padStart(64, "0");
process.env.NODE_ENV = "test";

const outputs = [
  "./dist/stratigraphy.contract.test.js",
  "./dist/pricing.test.js",
  "./dist/settlement_redundancy.test.js",
  "./dist/coinos-uuid-settlement.test.js",
  "./dist/stream.test.js",
  "./dist/nostrAttestation.test.js",
  "./dist/agentReputation.test.js",
  "./dist/multiSettlement.test.js",
  "./dist/zkProof.test.js",
  "./dist/meshGossip.test.js",
  "./dist/dvm.test.js",
  "./dist/l402.test.js",
  "./dist/announcer.test.js",
  "./dist/ledger.test.js",
  "./dist/orchestrator.test.js",
  "./dist/epistemicGrounding.test.js",
];

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
    "meshGossip.test": "../../tests/meshGossip.test.ts",
    "dvm.test": "./tests/unit/dvm.test.ts",
    "l402.test": "../../tests/l402.test.ts",
    "announcer.test": "../../tests/announcer.test.ts",
    "ledger.test": "../../tests/ledger.test.ts",
    "orchestrator.test": "../../tests/orchestrator.test.ts",
    "epistemicGrounding.test": "../../tests/epistemicGrounding.test.ts",
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