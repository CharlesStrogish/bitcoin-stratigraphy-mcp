import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const buildableSourcePattern = /\.[cm]?[jt]sx?$/;
const buildConfigPattern =
  /^(?:build\.[cm]?[jt]s|tsconfig(?:\.[\w-]+)?\.json|(?:babel|esbuild|parcel|rollup|rspack|tsup|vite|webpack)\.config\.[cm]?[jt]s)$/;

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

function scriptReachesCommand(
  scripts,
  scriptName,
  commandPattern,
  visited = new Set(),
) {
  if (visited.has(scriptName)) {
    return false;
  }

  visited.add(scriptName);
  const command = scripts?.[scriptName];

  if (typeof command !== "string") {
    return false;
  }

  if (commandPattern.test(command)) {
    return true;
  }

  const calledScripts = [
    ...command.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)\b/g),
  ].map((match) => match[1]);

  return calledScripts.some((calledScript) =>
    scriptReachesCommand(scripts, calledScript, commandPattern, visited),
  );
}

function rootBuildRunsAllPackageBuilds(buildCommand) {
  return buildCommand
    .split(/&&|\|\||[;|]/)
    .some(
      (command) =>
        /\bpnpm\s+(?:-r|--recursive)\b[^;|]*\brun\s+build\b/.test(command) &&
        !/(?:^|\s)(?:--filter|-F)(?:\s|=)/.test(command),
    );
}

function fileMakesPackageBuildable(relativeFilePath) {
  const pathParts = relativeFilePath.split(path.sep);
  const fileName = pathParts.at(-1);

  return (
    buildConfigPattern.test(fileName) ||
    (pathParts[0] === "src" && buildableSourcePattern.test(fileName))
  );
}

function packageIsBuildable(packagePath) {
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
      } else if (
        entry.isFile() &&
        fileMakesPackageBuildable(
          path.relative(packagePath, path.join(directory, entry.name)),
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function packagesMissingBuildPaths(
  packages,
  referencedPackagePaths,
  recursiveBuildCoversAllPackages,
  isBuildable = packageIsBuildable,
) {
  return packages
    .filter(
      ({ path: packagePath }) => path.resolve(packagePath) !== workspaceRoot,
    )
    .filter(({ path: packagePath }) => isBuildable(packagePath))
    .filter(({ path: packagePath }) => {
      const resolvedPath = path.resolve(packagePath);
      const packageJson = readJson(path.join(packagePath, "package.json"));
      return (
        !(
          recursiveBuildCoversAllPackages &&
          typeof packageJson.scripts?.build === "string"
        ) && !referencedPackagePaths.has(resolvedPath)
      );
    })
    .map(
      ({ name, path: packagePath }) =>
        name ?? path.relative(workspaceRoot, packagePath),
    )
    .sort();
}

test("a buildable package without a build path is reported", () => {
  const packagePath = path.join(workspaceRoot, "lib/api-spec");
  const missingBuildPaths = packagesMissingBuildPaths(
    [{ name: "@workspace/api-spec", path: packagePath }],
    new Set(),
    true,
    () => true,
  );

  assert.deepEqual(missingBuildPaths, ["@workspace/api-spec"]);
});

test("a root TypeScript project reference is a build path", () => {
  const packagePath = path.join(workspaceRoot, "lib/api-zod");
  const missingBuildPaths = packagesMissingBuildPaths(
    [{ name: "@workspace/api-zod", path: packagePath }],
    new Set([packagePath]),
    true,
    () => true,
  );

  assert.deepEqual(missingBuildPaths, []);
});

test("project references are uncovered when root build does not reach tsc build", () => {
  const packagePath = path.join(workspaceRoot, "lib/api-zod");
  const scripts = {
    build: "pnpm -r --if-present run build",
    "typecheck:libs": "tsc --build",
  };
  const referencedPackagePaths = scriptReachesCommand(
    scripts,
    "build",
    /\btsc\s+(?:--build|-b)\b/,
  )
    ? new Set([packagePath])
    : new Set();
  const missingBuildPaths = packagesMissingBuildPaths(
    [{ name: "@workspace/api-zod", path: packagePath }],
    referencedPackagePaths,
    true,
    () => true,
  );

  assert.deepEqual(missingBuildPaths, ["@workspace/api-zod"]);
});

test("a filtered recursive build reports an excluded package with a build script", () => {
  const packagePath = path.join(workspaceRoot, "scripts");
  const buildCommand =
    'pnpm -r --filter "./artifacts/**" --if-present run build';
  const missingBuildPaths = packagesMissingBuildPaths(
    [{ name: "@workspace/scripts", path: packagePath }],
    new Set(),
    rootBuildRunsAllPackageBuilds(buildCommand),
    () => true,
  );

  assert.deepEqual(missingBuildPaths, ["@workspace/scripts"]);
});

test("source nested beneath src makes a package buildable", () => {
  assert.equal(
    fileMakesPackageBuildable(path.join("src", "components", "App.tsx")),
    true,
  );
});

test("JavaScript and TypeScript build files make packages buildable", () => {
  assert.equal(fileMakesPackageBuildable("build.js"), true);
  assert.equal(fileMakesPackageBuildable("build.ts"), true);
});

test("root build covers every buildable workspace package", () => {
  const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
  const buildCommand = rootPackage.scripts?.build ?? "";

  const recursiveBuildCoversAllPackages =
    rootBuildRunsAllPackageBuilds(buildCommand);
  assert.equal(
    recursiveBuildCoversAllPackages,
    true,
    "The root build command must recursively run workspace build scripts",
  );

  const rootTsconfig = readJson(path.join(workspaceRoot, "tsconfig.json"));
  const buildReachesTypeScriptProjects = scriptReachesCommand(
    rootPackage.scripts,
    "build",
    /\btsc\s+(?:--build|-b)\b/,
  );
  const referencedPackagePaths = buildReachesTypeScriptProjects
    ? new Set(
        (rootTsconfig.references ?? [])
          .map(({ path: referencePath }) =>
            path.resolve(workspaceRoot, referencePath),
          )
          .filter((packagePath) =>
            existsSync(path.join(packagePath, "package.json")),
          ),
      )
    : new Set();
  const missingBuildPaths = packagesMissingBuildPaths(
    listWorkspacePackages(),
    referencedPackagePaths,
    recursiveBuildCoversAllPackages,
  );

  assert.deepEqual(
    missingBuildPaths,
    [],
    `Buildable workspace packages missing from the root build: ${missingBuildPaths.join(", ")}`,
  );
});
