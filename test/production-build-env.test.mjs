import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

const artifacts = [
  {
    name: "Canvas",
    packageName: "@workspace/mockup-sandbox",
    artifactDirectory: "mockup-sandbox",
  },
  {
    name: "Bitcoin Stratigraphy Dashboard",
    packageName: "@workspace/bitcoin-stratigraphy-dashboard",
    artifactDirectory: "bitcoin-stratigraphy-dashboard",
  },
];

function readArtifactBasePath(artifactDirectory) {
  const artifactConfig = readFileSync(
    path.join(
      workspaceRoot,
      "artifacts",
      artifactDirectory,
      ".replit-artifact",
      "artifact.toml",
    ),
    "utf8",
  );
  const previewPath = artifactConfig.match(/^previewPath\s*=\s*"([^"]+)"$/m)?.[1];
  const basePath = artifactConfig.match(/^BASE_PATH\s*=\s*"([^"]+)"$/m)?.[1];

  assert.ok(previewPath, `${artifactDirectory} must declare previewPath`);
  assert.ok(basePath, `${artifactDirectory} must inject BASE_PATH`);
  assert.equal(
    basePath.replace(/\/?$/, "/"),
    previewPath.replace(/\/?$/, "/"),
    `${artifactDirectory} BASE_PATH must match previewPath`,
  );
  return basePath.replace(/\/?$/, "/");
}

function buildWithArtifactRouting({
  name,
  packageName,
  artifactDirectory,
}) {
  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), `${packageName.split("/").at(-1)}-production-build-`),
  );
  const environment = { ...process.env };
  delete environment.PORT;
  environment.BASE_PATH = readArtifactBasePath(artifactDirectory);

  try {
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        packageName,
        "run",
        "build",
        "--outDir",
        outputDirectory,
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: environment,
      },
    );

    assert.equal(
      result.status,
      0,
      `${name} must build with the artifact preview path.\n${result.stdout}\n${result.stderr}`,
    );

    const html = readFileSync(path.join(outputDirectory, "index.html"), "utf8");
    const assetUrls = [
      ...html.matchAll(
        /<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g,
      ),
    ]
      .map((match) => match[1])
      .filter((url) => url.includes("/assets/"));

    assert.ok(assetUrls.length > 0, `${name} must emit asset URLs in index.html`);
    assert.ok(
      assetUrls.every((url) => url.startsWith(environment.BASE_PATH)),
      `${name} assets must use ${environment.BASE_PATH}. Found: ${assetUrls.join(", ")}`,
    );
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

for (const artifact of artifacts) {
  test(`${artifact.name} production assets follow the artifact preview path`, () => {
    buildWithArtifactRouting(artifact);
  });
}
