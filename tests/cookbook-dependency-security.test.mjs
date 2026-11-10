import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "@iarna/toml";

test("HTTP/TLS security floors prevent vulnerable Python dependency resolution", () => {
  const project = parse(
    readFileSync(new URL("../pyproject.toml", import.meta.url), "utf8"),
  );
  const lock = parse(
    readFileSync(new URL("../uv.lock", import.meta.url), "utf8"),
  );
  const starter = readFileSync(
    new URL("../starter-swarm-python/requirements.txt", import.meta.url),
    "utf8",
  ).split(/\r?\n/);

  // Covers GHSA-82r6-8w77-94w6 / PYSEC-2026-4025,
  // GHSA-5p39-cfhj-2xmp / PYSEC-2026-4024,
  // GHSA-6q48-6c7w-9gw2 / PYSEC-2026-4320, and
  // GHSA-65pc-fj4g-8rjx / PYSEC-2026-215.
  for (const [name, minimum] of [
    ["anyio", "4.14.2"],
    ["certifi", "2026.10.19"],
    ["idna", "3.15"],
  ]) {
    const requirement = `${name}>=${minimum}`;
    const requirements =
      name === "certifi"
        ? project.project.dependencies
        : project.tool.uv["constraint-dependencies"];
    assert.ok(requirements.includes(requirement), `Missing ${requirement}`);
    assert.ok(starter.includes(requirement), `Starter missing ${requirement}`);

    if (name !== "certifi") {
      assert.ok(
        lock.manifest.constraints.some(
          (entry) => entry.name === name && entry.specifier === `>=${minimum}`,
        ),
        `Lockfile constraint missing ${requirement}`,
      );
    }

    const locked = lock.package.filter((entry) => entry.name === name);
    assert.ok(locked.length > 0, `${name} must remain locked`);
    for (const entry of locked) {
      assert.match(entry.version, /^\d+(?:\.\d+)*$/);
      const actual = entry.version.split(".").map(Number);
      const floor = minimum.split(".").map(Number);
      let comparison = 0;
      for (let i = 0; i < Math.max(actual.length, floor.length); i++) {
        comparison = (actual[i] ?? 0) - (floor[i] ?? 0);
        if (comparison !== 0) break;
      }
      assert.ok(
        comparison >= 0,
        `Expected ${requirement}, locked ${entry.version}`,
      );
    }
  }
});

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
