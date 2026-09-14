import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

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

async function requestSuccessful(url, artifactName, resourceType, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(
      `${artifactName}: ${resourceType} request failed for ${url}: ${error.message}`,
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

export async function checkPublishedAssets({
  deploymentUrl,
  artifacts = discoverPublishedWebArtifacts(),
  apiArtifacts = discoverPublishedApiArtifacts(),
  fetchImpl = fetch,
}) {
  assert.ok(deploymentUrl, "PUBLISHED_URL must be provided");
  assert.ok(
    artifacts.length + apiArtifacts.length > 0,
    "At least one published artifact must be covered",
  );

  const deploymentBase = new URL(deploymentUrl);

  for (const artifact of apiArtifacts) {
    const livenessUrl = new URL(artifact.livenessPath, deploymentBase);
    await requestSuccessful(
      livenessUrl,
      artifact.name,
      "liveness endpoint",
      fetchImpl,
    );
    console.log(`${artifact.name}: ${livenessUrl} is reachable`);
  }

  for (const artifact of artifacts) {
    const entryUrl = new URL(artifact.previewPath, deploymentBase);
    const entryResponse = await requestSuccessful(
      entryUrl,
      artifact.name,
      "entry page",
      fetchImpl,
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
      );
      assertAssetMediaType(assetResponse, assetUrl, artifact.name);
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
