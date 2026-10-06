import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/routes/docs.test.ts"],
  outfile: "dist/docs.test.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
});
const result = spawnSync(process.execPath, ["--test", "dist/docs.test.mjs"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
