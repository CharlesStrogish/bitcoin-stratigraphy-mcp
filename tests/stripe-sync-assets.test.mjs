import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyStripeSyncMigrations } from "../artifacts/api-server/stripe-sync-assets.mjs";

test("the production bundle ships every native Stripe SQL migration byte-for-byte", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stripe-assets-"));
  try {
    const { source, files } = await copyStripeSyncMigrations(directory);
    assert(files.includes("0000_initial_migration.sql"));
    assert.deepEqual(
      (await readdir(path.join(directory, "migrations"))).sort(),
      (await readdir(source)).sort(),
    );
    for (const file of files) {
      assert.deepEqual(
        await readFile(path.join(directory, "migrations", file)),
        await readFile(path.join(source, file)),
      );
    }
    const build = await readFile(
      new URL("../artifacts/api-server/build.mjs", import.meta.url),
      "utf8",
    );
    assert.match(build, /await copyStripeSyncMigrations\(distDir\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
