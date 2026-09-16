import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outputs = [
  "./dist/stratigraphy.contract.test.js",
  "./dist/pricing.test.js",
];

await build({
  entryPoints: {
    "stratigraphy.contract.test": "./src/routes/stratigraphy.contract.test.ts",
    "pricing.test": "./tests/unit/pricing.test.ts",
  },
  outdir: "./dist",
  bundle: true,
  platform: "node",
  format: "esm",
  loader: { ".yaml": "text" },
  external: ["express", "@getalby/sdk", "yaml"],
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