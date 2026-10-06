import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("unpatched LlamaIndex/NLTK dependency chain is excluded from the cookbook", () => {
  const manifest = readFileSync(
    new URL(
      "../cookbooks/frameworks/requirements-llamaindex.txt",
      import.meta.url,
    ),
    "utf8",
  );
  const requirements = manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.deepEqual(
    requirements,
    [],
    "Do not restore LlamaIndex until its NLTK dependency is safe",
  );
  assert.match(manifest, /GHSA-8mgp-746c-j5xp/);
});
