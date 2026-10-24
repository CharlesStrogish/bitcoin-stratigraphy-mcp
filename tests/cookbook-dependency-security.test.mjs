import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "@iarna/toml";

test("MCP requirements and lockfile exclude GHSA-84m7-p3x7-pcfv", () => {
  const project = parse(
    readFileSync(new URL("../pyproject.toml", import.meta.url), "utf8"),
  );
  const cookbook = readFileSync(
    new URL("../cookbooks/requirements.txt", import.meta.url),
    "utf8",
  );
  const requirement = project.project.dependencies.find((dependency) =>
    dependency.startsWith("mcp>="),
  );
  assert.equal(requirement, "mcp>=1.30.0,<2");
  assert.ok(cookbook.split(/\r?\n/).includes(requirement));

  const lock = parse(
    readFileSync(new URL("../uv.lock", import.meta.url), "utf8"),
  );
  const mcp = lock.package.find((dependency) => dependency.name === "mcp");
  assert.ok(mcp, "MCP must remain locked");
  const [major, minor] = mcp.version.split(".").map(Number);
  assert.ok(
    major === 1 && minor >= 30,
    `Expected patched MCP 1.x (>=1.30.0), got ${mcp.version}`,
  );
});

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
