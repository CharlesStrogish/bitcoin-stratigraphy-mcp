import assert from "node:assert/strict";
import test from "node:test";

import {
  checkPublishedAssets,
  discoverPublishedApiArtifacts,
  discoverPublishedWebArtifacts,
  findJavaScriptAndCssUrls,
} from "../scripts/check-published-assets.mjs";

test("discovers registered web artifacts with production services", () => {
  const artifacts = discoverPublishedWebArtifacts();

  assert.ok(
    artifacts.some(
      (artifact) => artifact.directory === "bitcoin-stratigraphy-dashboard",
    ),
  );
  assert.ok(
    !artifacts.some((artifact) => artifact.directory === "mockup-sandbox"),
    "development-only artifacts must not be checked as published routes",
  );
});

test("discovers API artifacts with published liveness endpoints", () => {
  const artifacts = discoverPublishedApiArtifacts();

  assert.ok(
    artifacts.some(
      (artifact) =>
        artifact.directory === "api-server" &&
        artifact.name === "API Server" &&
        artifact.livenessPath === "/api/healthz",
    ),
  );
});

test("finds referenced JavaScript and CSS assets", () => {
  assert.deepEqual(
    findJavaScriptAndCssUrls(`
      <link rel="stylesheet" href="/app/assets/site.css">
      <link rel="icon" href="/favicon.svg">
      <script type="module" src="/app/assets/main.js"></script>
    `),
    ["/app/assets/site.css", "/app/assets/main.js"],
  );
});

test("checks entry pages and their referenced assets", async () => {
  const requested = [];
  const responses = new Map([
    [
      "https://published.example/app",
      new Response(
        '<link href="/app/assets/site.css"><script src="./assets/main.js"></script>',
      ),
    ],
    [
      "https://published.example/app/assets/site.css",
      new Response("body{}", { headers: { "content-type": "text/css" } }),
    ],
    [
      "https://published.example/assets/main.js",
      new Response("export {}", {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }),
    ],
  ]);

  await checkPublishedAssets({
    deploymentUrl: "https://published.example",
    artifacts: [{ name: "Example App", previewPath: "/app" }],
    apiArtifacts: [],
    fetchImpl: async (url) => {
      const key = url.toString();
      requested.push(key);
      return responses.get(key) ?? new Response("missing", { status: 404 });
    },
  });

  assert.deepEqual(requested, [...responses.keys()]);
});

test("checks API liveness without payment or data mutation", async () => {
  const requested = [];

  await checkPublishedAssets({
    deploymentUrl: "https://published.example",
    artifacts: [],
    apiArtifacts: [
      { name: "Example API", livenessPath: "/api/healthz" },
    ],
    fetchImpl: async (url) => {
      requested.push(url.toString());
      return new Response('{"status":"ok"}');
    },
  });

  assert.deepEqual(requested, ["https://published.example/api/healthz"]);
});

test("API liveness failures identify the artifact and URL", async () => {
  await assert.rejects(
    checkPublishedAssets({
      deploymentUrl: "https://published.example",
      artifacts: [],
      apiArtifacts: [
        { name: "Example API", livenessPath: "/api/healthz" },
      ],
      fetchImpl: async () =>
        new Response("unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    }),
    /Example API: liveness endpoint returned 503 Service Unavailable for https:\/\/published\.example\/api\/healthz/,
  );
});

test("asset failures identify the artifact and broken URL", async () => {
  await assert.rejects(
    checkPublishedAssets({
      deploymentUrl: "https://published.example",
      artifacts: [{ name: "Example App", previewPath: "/app/" }],
      apiArtifacts: [],
      fetchImpl: async (url) =>
        url.toString().endsWith("/app/")
          ? new Response('<script src="/app/assets/broken.js"></script>')
          : new Response("missing", { status: 404, statusText: "Not Found" }),
    }),
    /Example App: asset returned 404 Not Found for https:\/\/published\.example\/app\/assets\/broken\.js/,
  );
});

test("rejects HTML fallback responses returned for missing assets", async () => {
  await assert.rejects(
    checkPublishedAssets({
      deploymentUrl: "https://published.example",
      artifacts: [{ name: "Example App", previewPath: "/app/" }],
      apiArtifacts: [],
      fetchImpl: async (url) =>
        url.toString().endsWith("/app/")
          ? new Response('<script src="/app/assets/missing.js"></script>')
          : new Response("<!doctype html><title>Example App</title>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
    }),
    /Example App: asset returned text\/html instead of JavaScript for https:\/\/published\.example\/app\/assets\/missing\.js/,
  );
});
