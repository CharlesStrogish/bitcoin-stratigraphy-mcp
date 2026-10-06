import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listWorkspacePackages(filters = []) {
  const result = spawnSync(
    "pnpm",
    [
      "--recursive",
      ...filters.flatMap((filter) => ["--filter", filter]),
      "list",
      "--depth",
      "-1",
      "--json",
    ],
    { cwd: workspaceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rootTypecheckFilters(typecheckCommand) {
  return [
    ...typecheckCommand.matchAll(/--filter\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g),
  ].map((match) => match[1] ?? match[2] ?? match[3]);
}

function filteredTypecheckPackagePaths(
  filters,
  listPackages = listWorkspacePackages,
) {
  if (filters.length === 0) {
    return new Set();
  }

  return new Set(
    listPackages(filters)
      .filter(({ path: packagePath }) => {
        const packageJson = readJson(path.join(packagePath, "package.json"));
        return typeof packageJson.scripts?.typecheck === "string";
      })
      .map(({ path: packagePath }) => path.resolve(packagePath)),
  );
}

test("removing every typecheck filter covers no filtered packages", () => {
  const selectedPaths = filteredTypecheckPackagePaths([], () => {
    throw new Error("an empty filter list must not query every package");
  });

  assert.deepEqual([...selectedPaths], []);
});

test("a filtered package without a typecheck script is not covered", () => {
  const packagePath = path.join(workspaceRoot, "lib/api-spec");
  const selectedPaths = filteredTypecheckPackagePaths(["./lib/**"], () => [
    { name: "@workspace/api-spec", path: packagePath },
  ]);

  assert.equal(selectedPaths.has(packagePath), false);
});

test("root typecheck covers every TypeScript workspace package", () => {
  const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
  const typecheckCommand = rootPackage.scripts?.typecheck ?? "";
  const filters = rootTypecheckFilters(typecheckCommand);
  const selectedPackagePaths = filteredTypecheckPackagePaths(filters);

  const rootTsconfig = readJson(path.join(workspaceRoot, "tsconfig.json"));
  const referencedPackagePaths = new Set(
    (rootTsconfig.references ?? []).map(({ path: referencePath }) =>
      path.resolve(workspaceRoot, referencePath),
    ),
  );

  const uncoveredPackages = listWorkspacePackages()
    .filter(
      ({ path: packagePath }) => path.resolve(packagePath) !== workspaceRoot,
    )
    .filter(({ path: packagePath }) =>
      existsSync(path.join(packagePath, "tsconfig.json")),
    )
    .filter(({ path: packagePath }) => {
      const resolvedPath = path.resolve(packagePath);
      return (
        !referencedPackagePaths.has(resolvedPath) &&
        !selectedPackagePaths.has(resolvedPath)
      );
    })
    .map(
      ({ name, path: packagePath }) =>
        name ?? path.relative(workspaceRoot, packagePath),
    )
    .sort();

  assert.deepEqual(
    uncoveredPackages,
    [],
    `TypeScript workspace packages missing from the root typecheck: ${uncoveredPackages.join(", ")}`,
  );
});
