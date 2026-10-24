import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPackageBuildEnvironment,
  readArtifactBuildBasePath,
} from "../scripts/build-workspace.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

test("artifact builds use their own registered proxy paths", () => {
  const dashboardEnvironment = createPackageBuildEnvironment(
    path.join(workspaceRoot, "artifacts", "bitcoin-stratigraphy-dashboard"),
    { BASE_PATH: "/wrong-global-path", PORT: "1234", SENTINEL: "preserved" },
  );
  const mockupEnvironment = createPackageBuildEnvironment(
    path.join(workspaceRoot, "artifacts", "mockup-sandbox"),
    { BASE_PATH: "/wrong-global-path" },
  );

  assert.equal(dashboardEnvironment.BASE_PATH, "/");
  assert.equal(mockupEnvironment.BASE_PATH, "/__mockup");
  assert.equal(dashboardEnvironment.PORT, undefined);
  assert.equal(dashboardEnvironment.SENTINEL, "preserved");
});

test("packages without artifact BASE_PATH do not inherit a global value", () => {
  const environment = createPackageBuildEnvironment(
    path.join(workspaceRoot, "artifacts", "api-server"),
    { BASE_PATH: "/wrong-global-path" },
  );

  assert.equal(environment.BASE_PATH, undefined);
});

test("artifact build routing rejects BASE_PATH drift from previewPath", () => {
  const packageDirectory = mkdtempSync(
    path.join(tmpdir(), "artifact-build-routing-"),
  );

  try {
    mkdirSync(path.join(packageDirectory, ".replit-artifact"));
    writeFileSync(
      path.join(packageDirectory, ".replit-artifact", "artifact.toml"),
      `
        previewPath = "/registered"
        [[services]]
        [services.env]
        BASE_PATH = "/stale"
      `,
    );

    assert.throws(
      () => readArtifactBuildBasePath(packageDirectory),
      /BASE_PATH must match previewPath/,
    );
  } finally {
    rmSync(packageDirectory, { recursive: true, force: true });
  }
});
