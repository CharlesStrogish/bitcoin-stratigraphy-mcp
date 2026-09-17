import { build } from "esbuild";
import { rm } from "node:fs/promises";

process.env.NOSTR_PRIVATE_KEY ??= "01".padStart(64, "0");

const outputs = [
  "./dist/stratigraphy.contract.test.js",
  "./dist/pricing.test.js",
  "./dist/settlement_redundancy.test.js",
  "./dist/stream.test.js",
  "./dist/nostrAttestation.test.js",
];

await build({
  entryPoints: {
    "stratigraphy.contract.test": "./src/routes/stratigraphy.contract.test.ts",
    "pricing.test": "./tests/unit/pricing.test.ts",
    "settlement_redundancy.test":
      "./tests/unit/settlement_redundancy.test.ts",
    "stream.test": "./tests/unit/stream.test.ts",
    "nostrAttestation.test": "../../tests/nostrAttestation.test.ts",
  },
  outdir: "./dist",
  bundle: true,
  platform: "node",
  format: "esm",
  loader: { ".yaml": "text" },
  external: ["express", "@getalby/sdk", "nostr-tools", "yaml"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  sourcemap: "inline",
});

const { spawnSync } = await import("node:child_process");
const results = outputs.map((output) =>
  spawnSync(process.execPath, ["--test", output], {
    stdio: "inherit",
  }),
);

await Promise.all(outputs.map((output) => rm(output, { force: true })));
process.exitCode = results.some((result) => result.status !== 0) ? 1 : 0;