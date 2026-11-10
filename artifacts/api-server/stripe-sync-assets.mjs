import assert from "node:assert/strict";
import { cp, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** The bundled Stripe migration runner resolves ./migrations beside server.mjs. */
export async function copyStripeSyncMigrations(distDir) {
  const source = path.join(
    path.dirname(require.resolve("stripe-replit-sync")),
    "migrations",
  );
  const files = (await readdir(source)).filter((file) => file.endsWith(".sql"));
  assert(files.length > 0, "Stripe sync SQL migration assets are required");
  await cp(source, path.join(distDir, "migrations"), { recursive: true });
  return { source, files };
}
