import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const ignoredDirectories = new Set([
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listWorkspacePackages() {
  const result = spawnSync(
    "pnpm",
    ["--recursive", "list", "--depth", "-1", "--json"],
    { cwd: workspaceRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function packageContainsTests(packagePath) {
  const pendingDirectories = [packagePath];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (
          !ignoredDirectories.has(entry.name) &&
          !entry.name.startsWith(".")
        ) {
          pendingDirectories.push(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && testFilePattern.test(entry.name)) {
        return true;
      }
    }
  }

  return false;
}

function packagesMissingTestScripts(
  packages,
  containsTests = packageContainsTests,
) {
  return packages
    .filter(
      ({ path: packagePath }) => path.resolve(packagePath) !== workspaceRoot,
    )
    .filter(({ path: packagePath }) => containsTests(packagePath))
    .filter(({ path: packagePath }) => {
      const packageJson = readJson(path.join(packagePath, "package.json"));
      return typeof packageJson.scripts?.test !== "string";
    })
    .map(
      ({ name, path: packagePath }) =>
        name ?? path.relative(workspaceRoot, packagePath),
    )
    .sort();
}

test("a package containing tests without a test script is reported", () => {
  const packagePath = path.join(workspaceRoot, "lib/api-client-react");
  const missingScripts = packagesMissingTestScripts(
    [{ name: "@workspace/api-client-react", path: packagePath }],
    () => true,
  );

  assert.deepEqual(missingScripts, ["@workspace/api-client-react"]);
});

test("a package test script is reached by the recursive root test command", () => {
  const packagePath = path.join(workspaceRoot, "lib/api-spec");
  const missingScripts = packagesMissingTestScripts(
    [{ name: "@workspace/api-spec", path: packagePath }],
    () => true,
  );

  assert.deepEqual(missingScripts, []);
});

test("root test covers every workspace package containing test files", () => {
  const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
  const testCommand = rootPackage.scripts?.test ?? "";

  assert.match(
    testCommand,
    /\bpnpm\s+(?:-r|--recursive)\b[^&|;]*\brun\s+test\b/,
    "The root test command must recursively run workspace test scripts",
  );

  const missingScripts = packagesMissingTestScripts(listWorkspacePackages());

  assert.deepEqual(
    missingScripts,
    [],
    `Workspace packages containing tests but missing from the root test suite: ${missingScripts.join(", ")}`,
  );
});
