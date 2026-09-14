import { build } from "esbuild";
import { rm } from "node:fs/promises";

const output = "./dist/stratigraphy.contract.test.mjs";

await build({
  entryPoints: ["./src/routes/stratigraphy.contract.test.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["express", "@getalby/sdk", "yaml"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  sourcemap: "inline",
});

const result = await import("node:child_process").then(
  ({ spawnSync }) =>
    spawnSync(process.execPath, ["--test", output], {
      stdio: "inherit",
    }),
);

await rm(output, { force: true });
process.exitCode = result.status ?? 1;