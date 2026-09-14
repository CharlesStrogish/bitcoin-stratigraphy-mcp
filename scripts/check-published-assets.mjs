import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

// Release checks should fail promptly enough to leave time for actionable output.
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

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
      assert.ok(livenessPath, `${entry.name} must declare a startup health path`);

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
) {
  let timeout;
  const bodyRead = response.arrayBuffer();
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
    if (error.message.startsWith(`${artifactName}: asset body timed out`)) {
      void response.body?.cancel(error).catch(() => {});
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

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.status !== "ok"
  ) {
    throw new Error(
      `${artifactName}: liveness endpoint returned an unhealthy response for ${livenessUrl}`,
    );
  }
}

export async function checkPublishedAssets({
  deploymentUrl,
  artifacts = discoverPublishedWebArtifacts(),
  apiArtifacts = discoverPublishedApiArtifacts(),
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  assert.ok(deploymentUrl, "PUBLISHED_URL must be provided");
  assert.ok(
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0,
    "requestTimeoutMs must be a positive number",
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

    for (const assetUrl of assetUrls) {
      const assetResponse = await requestSuccessful(
        assetUrl,
        artifact.name,
        "asset",
        fetchImpl,
        requestTimeoutMs,
      );
      assertAssetMediaType(assetResponse, assetUrl, artifact.name);
      await consumeAssetBody(
        assetResponse,
        assetUrl,
        artifact.name,
        requestTimeoutMs,
      );
    }

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
