import TOML from "@iarna/toml";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.stdio !== "inherit") {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

export function readArtifactBuildBasePath(packageDirectory) {
  const artifactConfigPath = path.join(
    packageDirectory,
    ".replit-artifact",
    "artifact.toml",
  );
  let artifactConfig;

  try {
    artifactConfig = TOML.parse(readFileSync(artifactConfigPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Could not read artifact routing from ${artifactConfigPath}`, {
      cause: error,
    });
  }

  const configuredBasePaths = (artifactConfig.services ?? [])
    .map((service) => service.env?.BASE_PATH)
    .filter((basePath) => basePath !== undefined);

  if (configuredBasePaths.length === 0) {
    return undefined;
  }

  const uniqueBasePaths = new Set(configuredBasePaths);
  if (uniqueBasePaths.size !== 1) {
    throw new Error(
      `${artifactConfigPath} declares conflicting BASE_PATH values`,
    );
  }

  const [basePath] = uniqueBasePaths;
  if (basePath !== artifactConfig.previewPath) {
    throw new Error(
      `${artifactConfigPath} BASE_PATH must match previewPath`,
    );
  }

  return basePath;
}

export function createPackageBuildEnvironment(
  packageDirectory,
  inheritedEnvironment = process.env,
) {
  const environment = { ...inheritedEnvironment };
  delete environment.BASE_PATH;
  delete environment.PORT;

  const basePath = readArtifactBuildBasePath(packageDirectory);
  if (basePath !== undefined) {
    environment.BASE_PATH = basePath;
  }

  return environment;
}

export function listWorkspacePackages() {
  return JSON.parse(run("pnpm", ["-r", "--depth", "-1", "--json", "list"]));
}

export function listWorkspaceBuildPackages(
  workspacePackages = listWorkspacePackages(),
) {
  return workspacePackages.flatMap((workspacePackage) => {
    const packageDirectory = path.resolve(workspacePackage.path);
    if (packageDirectory === workspaceRoot) {
      return [];
    }

    const packageManifest = JSON.parse(
      readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
    );
    if (!packageManifest.scripts?.build) {
      return [];
    }

    return [{ packageDirectory, packageManifest }];
  });
}

function buildWorkspace() {
  for (const {
    packageDirectory,
    packageManifest,
  } of listWorkspaceBuildPackages()) {
    process.stdout.write(`\nBuilding ${packageManifest.name}\n`);
    run("pnpm", ["--dir", packageDirectory, "run", "build"], {
      env: createPackageBuildEnvironment(packageDirectory),
      stdio: "inherit",
    });
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  buildWorkspace();
}