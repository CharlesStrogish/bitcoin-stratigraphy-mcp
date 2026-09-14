import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HEALTH_CHECK_RESPONSE,
  isHealthCheckResponse,
} from "../lib/api-zod/health-check-contract.mjs";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

// Release checks should fail promptly enough to leave time for actionable output.
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_ASSET_CONCURRENCY = 8;
export const DEFAULT_ASSET_BODY_LIMIT_BYTES = 25 * 1024 * 1024;

function readTomlString(source, key) {
  return source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
}

export function discoverPublishedWebArtifacts(root = workspaceRoot) {
  const artifactsDirectory = path.join(root, "artifacts");

  return readdirSync(artifactsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const configPath = path.join(
        artifactsDirectory,
        entry.name,
        ".replit-artifact",
        "artifact.toml",
      );
      const config = readFileSync(configPath, "utf8");
      const kind = readTomlString(config, "kind");
      const hasProductionService = /^\[services\.production\]$/m.test(config);

      if (kind === "api" || !hasProductionService) {
        return [];
      }

      const previewPath = readTomlString(config, "previewPath");
      assert.ok(previewPath, `${entry.name} must declare previewPath`);

      return [
        {
          directory: entry.name,
          name: readTomlString(config, "title") ?? entry.name,
          previewPath,
        },
      ];
    });
}

export function discoverPublishedApiArtifacts(root = workspaceRoot) {
  const artifactsDirectory = path.join(root, "artifacts");

  return readdirSync(artifactsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const configPath = path.join(
        artifactsDirectory,
        entry.name,
        ".replit-artifact",
        "artifact.toml",
      );
      const config = readFileSync(configPath, "utf8");

      if (readTomlString(config, "kind") !== "api") {
        return [];
      }

      const livenessPath = config.match(
        /^\[services\.production\.health\.startup\]\s*$[\s\S]*?^path\s*=\s*"([^"]+)"/m,
      )?.[1];
      assert.ok(
        livenessPath,
        `${entry.name} must declare a startup health path`,
      );

      return [
        {
          directory: entry.name,
          name: readTomlString(config, "title") ?? entry.name,
          livenessPath,
        },
      ];
    });
}

export function findJavaScriptAndCssUrls(html) {
  return [
    ...html.matchAll(
      /<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"'#]+)["'][^>]*>/gi,
    ),
  ]
    .map((match) => match[1])
    .filter((url) => /\.(?:css|m?js)(?:[?#]|$)/i.test(url));
}

async function requestSuccessful(
  url,
  artifactName,
  resourceType,
  fetchImpl,
  requestTimeoutMs,
) {
  let response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const timeoutDetail =
      error?.name === "TimeoutError"
        ? ` timed out after ${requestTimeoutMs}ms`
        : " failed";
    throw new Error(
      `${artifactName}: ${resourceType} request${timeoutDetail} for ${url}: ${error.message}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(
      `${artifactName}: ${resourceType} returned ${response.status} ${response.statusText} for ${url}`,
    );
  }
  return response;
}

function assertAssetMediaType(response, assetUrl, artifactName) {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const isCss = /\.css(?:[?#]|$)/i.test(assetUrl.pathname);
  const acceptedMediaTypes = isCss
    ? new Set(["text/css"])
    : new Set([
        "application/ecmascript",
        "application/javascript",
        "text/ecmascript",
        "text/javascript",
      ]);

  if (!mediaType || !acceptedMediaTypes.has(mediaType)) {
    throw new Error(
      `${artifactName}: asset returned ${mediaType ?? "no content type"} instead of ${isCss ? "CSS" : "JavaScript"} for ${assetUrl}`,
    );
  }
}

async function consumeAssetBody(
  response,
  assetUrl,
  artifactName,
  requestTimeoutMs,
  assetBodyLimitBytes,
) {
  let timeout;
  const reader = response.body?.getReader();
  assert.ok(
    reader,
    `${artifactName}: asset response had no readable body for ${assetUrl}`,
  );
  const bodyRead = (async () => {
    let bytesRead = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      bytesRead += value.byteLength;
      if (bytesRead > assetBodyLimitBytes) {
        const error = new Error(
          `${artifactName}: asset body exceeded ${assetBodyLimitBytes} bytes for ${assetUrl}`,
        );
        await reader.cancel(error).catch(() => {});
        throw error;
      }
    }
  })();
  const bodyTimeout = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `${artifactName}: asset body timed out after ${requestTimeoutMs}ms for ${assetUrl}`,
        ),
      );
    }, requestTimeoutMs);
  });

  try {
    await Promise.race([bodyRead, bodyTimeout]);
  } catch (error) {
    if (
      error.message.startsWith(`${artifactName}: asset body timed out`) ||
      error.message.startsWith(`${artifactName}: asset body exceeded`)
    ) {
      void reader.cancel(error).catch(() => {});
      throw error;
    }
    throw new Error(
      `${artifactName}: asset body download failed for ${assetUrl}: ${error.message}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAsset(
  assetUrl,
  artifactName,
  fetchImpl,
  requestTimeoutMs,
  assetBodyLimitBytes,
) {
  const assetResponse = await requestSuccessful(
    assetUrl,
    artifactName,
    "asset",
    fetchImpl,
    requestTimeoutMs,
  );
  assertAssetMediaType(assetResponse, assetUrl, artifactName);
  await consumeAssetBody(
    assetResponse,
    assetUrl,
    artifactName,
    requestTimeoutMs,
    assetBodyLimitBytes,
  );
}

async function checkAssetsConcurrently(
  assetUrls,
  artifactName,
  fetchImpl,
  requestTimeoutMs,
  assetConcurrency,
  assetBodyLimitBytes,
) {
  const failures = [];
  let nextAssetIndex = 0;

  async function worker() {
    while (nextAssetIndex < assetUrls.length) {
      const assetUrl = assetUrls[nextAssetIndex++];
      try {
        await checkAsset(
          assetUrl,
          artifactName,
          fetchImpl,
          requestTimeoutMs,
          assetBodyLimitBytes,
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(assetConcurrency, assetUrls.length) },
      () => worker(),
    ),
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      failures.map((error) => error.message).join("\n"),
    );
  }
}

async function assertHealthyApiResponse(response, livenessUrl, artifactName) {
  if (response.url && response.url !== livenessUrl.href) {
    throw new Error(
      `${artifactName}: liveness endpoint redirected from configured URL ${livenessUrl} to final URL ${response.url}`,
    );
  }

  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (mediaType !== "application/json") {
    throw new Error(
      `${artifactName}: liveness endpoint returned ${mediaType ?? "no content type"} instead of JSON for ${livenessUrl}`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(
      `${artifactName}: liveness endpoint returned invalid JSON for ${livenessUrl}: ${error.message}`,
      { cause: error },
    );
  }

  if (!isHealthCheckResponse(body)) {
    throw new Error(
      `${artifactName}: liveness endpoint response does not match the shared health contract for ${livenessUrl}; expected ${JSON.stringify(
        HEALTH_CHECK_RESPONSE,
      )}, received ${JSON.stringify(body)}`,
    );
  }
}

export async function checkPublishedAssets({
  deploymentUrl,
  artifacts = discoverPublishedWebArtifacts(),
  apiArtifacts = discoverPublishedApiArtifacts(),
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  assetConcurrency = DEFAULT_ASSET_CONCURRENCY,
  assetBodyLimitBytes = DEFAULT_ASSET_BODY_LIMIT_BYTES,
}) {
  assert.ok(deploymentUrl, "PUBLISHED_URL must be provided");
  assert.ok(
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0,
    "requestTimeoutMs must be a positive number",
  );
  assert.ok(
    Number.isInteger(assetConcurrency) && assetConcurrency > 0,
    "assetConcurrency must be a positive integer",
  );
  assert.ok(
    Number.isInteger(assetBodyLimitBytes) && assetBodyLimitBytes > 0,
    "assetBodyLimitBytes must be a positive integer",
  );
  assert.ok(
    artifacts.length + apiArtifacts.length > 0,
    "At least one published artifact must be covered",
  );

  const deploymentBase = new URL(deploymentUrl);

  for (const artifact of apiArtifacts) {
    const livenessUrl = new URL(artifact.livenessPath, deploymentBase);
    const livenessResponse = await requestSuccessful(
      livenessUrl,
      artifact.name,
      "liveness endpoint",
      fetchImpl,
      requestTimeoutMs,
    );
    await assertHealthyApiResponse(
      livenessResponse,
      livenessUrl,
      artifact.name,
    );
    console.log(`${artifact.name}: ${livenessUrl} is healthy`);
  }

  for (const artifact of artifacts) {
    const entryUrl = new URL(artifact.previewPath, deploymentBase);
    const entryResponse = await requestSuccessful(
      entryUrl,
      artifact.name,
      "entry page",
      fetchImpl,
      requestTimeoutMs,
    );
    const assetUrls = findJavaScriptAndCssUrls(await entryResponse.text()).map(
      (assetUrl) => new URL(assetUrl, entryUrl),
    );

    assert.ok(
      assetUrls.length > 0,
      `${artifact.name}: entry page ${entryUrl} referenced no JavaScript or CSS assets`,
    );

    await checkAssetsConcurrently(
      assetUrls,
      artifact.name,
      fetchImpl,
      requestTimeoutMs,
      assetConcurrency,
      assetBodyLimitBytes,
    );

    console.log(
      `${artifact.name}: ${entryUrl} and ${assetUrls.length} assets are reachable`,
    );
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  await checkPublishedAssets({ deploymentUrl: process.env.PUBLISHED_URL });
}
