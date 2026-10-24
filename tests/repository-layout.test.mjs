import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("repository tests use the unified root tests directory", () => {
  assert.equal(existsSync(new URL("test/", root)), false);
  const { scripts } = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  );
  assert.match(scripts.test, /node --test tests\/\*\.test\.mjs/);
  assert.match(scripts["test:python"], /scripts\/test-python\.sh/);
  assert.match(
    readFileSync(
      new URL("scripts/test-stratigraphy-coverage.sh", root),
      "utf8",
    ),
    /\$PWD\/tests:/,
  );
});

test("historical manifest evidence is archived together, not in the root", () => {
  for (const suffix of [".json", ".json.ots", ".sha256"]) {
    const name = `ENGINE_MASTER_MANIFEST${suffix}`;
    assert.equal(existsSync(new URL(name, root)), false);
    assert.equal(existsSync(new URL(`scripts/archive/${name}`, root)), true);
  }
});
