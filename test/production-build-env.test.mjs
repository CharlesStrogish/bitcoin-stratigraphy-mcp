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
    expectedAssetBase: "/__mockup/",
  },
  {
    name: "Bitcoin Stratigraphy Dashboard",
    packageName: "@workspace/bitcoin-stratigraphy-dashboard",
    expectedAssetBase: "/",
  },
];

function buildWithoutPreviewEnvironment({ name, packageName, expectedAssetBase }) {
  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), `${packageName.split("/").at(-1)}-production-build-`),
  );
  const environment = { ...process.env };
  delete environment.PORT;
  delete environment.BASE_PATH;

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
      `${name} must build without PORT or BASE_PATH.\n${result.stdout}\n${result.stderr}`,
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
      assetUrls.every((url) => url.startsWith(expectedAssetBase)),
      `${name} assets must use ${expectedAssetBase}. Found: ${assetUrls.join(", ")}`,
    );
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

for (const artifact of artifacts) {
  test(`${artifact.name} production build does not require preview environment`, () => {
    buildWithoutPreviewEnvironment(artifact);
  });
}