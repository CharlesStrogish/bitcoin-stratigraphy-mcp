import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

const webArtifactKinds = new Set(["data-app", "design", "web-app", "website"]);
const supportedBuildTools = [
  {
    name: "Vite",
    dependency: "vite",
    outputDirectoryArgument: "--outDir",
    assetPathSegment: "/assets/",
  },
  {
    name: "Astro",
    dependency: "astro",
    outputDirectoryArgument: "--outDir",
    assetPathSegment: "/_astro/",
  },
  {
    name: "Parcel",
    dependency: "parcel",
    outputDirectoryArgument: "--dist-dir",
    assetPathSegment: null,
  },
];

function readTomlString(source, key) {
  return source.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
}

function discoverWebArtifacts(
  rootDirectory = workspaceRoot,
  artifactConfigFilename = "artifact.toml",
) {
  const artifactsDirectory = path.join(rootDirectory, "artifacts");

  return readdirSync(artifactsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const artifactDirectory = entry.name;
      const artifactConfig = readFileSync(
        path.join(
          artifactsDirectory,
          artifactDirectory,
          ".replit-artifact",
          artifactConfigFilename,
        ),
        "utf8",
      );
      const kind = readTomlString(artifactConfig, "kind");

      if (!webArtifactKinds.has(kind)) {
        return [];
      }

      const packageManifest = JSON.parse(
        readFileSync(
          path.join(artifactsDirectory, artifactDirectory, "package.json"),
          "utf8",
        ),
      );

      const buildTool = supportedBuildTools.find(
        ({ dependency }) =>
          packageManifest.dependencies?.[dependency] ||
          packageManifest.devDependencies?.[dependency],
      );

      if (!buildTool) {
        return [];
      }

      assert.ok(
        packageManifest.scripts?.build,
        `${artifactDirectory} uses ${buildTool.name} and must declare a build script`,
      );
      assert.ok(
        packageManifest.name,
        `${artifactDirectory} must declare a package name`,
      );

      return [
        {
          name: readTomlString(artifactConfig, "title") ?? artifactDirectory,
          packageName: packageManifest.name,
          artifactDirectory,
          buildTool,
        },
      ];
    });
}

const artifacts = discoverWebArtifacts();

assert.ok(
  artifacts.length > 0,
  "At least one registered web artifact using a supported build tool must be covered",
);

const discoveryFixturesDirectory = path.join(
  workspaceRoot,
  "test",
  "fixtures",
  "artifact-discovery",
);

function discoverFixture(name) {
  return discoverWebArtifacts(
    path.join(discoveryFixturesDirectory, name),
    "fixture.toml",
  );
}

test("discovery includes a registered Vite web artifact", () => {
  assert.deepEqual(
    discoverFixture("vite-web").map(
      ({ name, packageName, artifactDirectory, buildTool }) => ({
        name,
        packageName,
        artifactDirectory,
        buildTool: buildTool.name,
      }),
    ),
    [
      {
        name: "Fixture Web App",
        packageName: "@fixtures/vite-web",
        artifactDirectory: "sample",
        buildTool: "Vite",
      },
    ],
  );
});

test("discovery excludes an API artifact with Vite build metadata", () => {
  assert.deepEqual(discoverFixture("api-vite"), []);
});

test("discovery accepts a Vite artifact with a wrapped build command", () => {
  const discovered = discoverFixture("vite-wrapped");

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].packageName, "@fixtures/vite-wrapped");
});

test("discovery rejects a Vite artifact without a package name", () => {
  assert.throws(
    () => discoverFixture("vite-missing-name"),
    /sample must declare a package name/,
  );
});

test("discovery rejects a Vite artifact without a build script", () => {
  assert.throws(
    () => discoverFixture("vite-missing-build"),
    /sample uses Vite and must declare a build script/,
  );
});

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
  const previewPath = artifactConfig.match(
    /^previewPath\s*=\s*"([^"]+)"$/m,
  )?.[1];
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

function isExcludedCssUrl(url) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);
}

function findEscapingCssAssetUrls(css, stylesheetUrl, basePath) {
  return [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*))\s*\)/gi)]
    .map((match) => (match[1] ?? match[2] ?? match[3]).trim())
    .filter((url) => url && !isExcludedCssUrl(url))
    .map((url) => ({
      url,
      resolvedPath: new URL(url, new URL(stylesheetUrl, "https://artifact.test"))
        .pathname,
    }))
    .filter(({ resolvedPath }) => !resolvedPath.startsWith(basePath));
}

test("CSS asset URLs must resolve within the artifact preview path", () => {
  const css = `
    @font-face { src: url("./font.woff2") }
    .local { background: url('../images/background.png') }
    .escaped { mask: url('/icons/mask.svg#shape') }
    .external { background: url("https://example.com/image.png") }
    .protocol-relative { background: url(//example.com/image.png) }
    .inline { background: url(data:image/svg+xml;base64,PHN2Zy8+) }
    .fragment { filter: url(#shadow) }
  `;

  assert.deepEqual(
    findEscapingCssAssetUrls(
      css,
      "/registered/assets/styles.css",
      "/registered/",
    ),
    [{ url: "/icons/mask.svg#shape", resolvedPath: "/icons/mask.svg" }],
  );
});

function buildWithArtifactRouting({
  name,
  packageName,
  artifactDirectory,
  buildTool,
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
        buildTool.outputDirectoryArgument,
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
    const emittedUrls = [
      ...html.matchAll(
        /<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]);
    const assetUrls = buildTool.assetPathSegment
      ? emittedUrls.filter((url) => url.includes(buildTool.assetPathSegment))
      : emittedUrls.filter(
          (url) =>
            !/^(?:data:|https?:|\/\/|#)/.test(url) && !url.endsWith(".html"),
        );

    assert.ok(
      assetUrls.length > 0,
      `${name} must emit asset URLs in index.html`,
    );
    assert.ok(
      assetUrls.every((url) => url.startsWith(environment.BASE_PATH)),
      `${name} assets must use ${environment.BASE_PATH}. Found: ${assetUrls.join(", ")}`,
    );

    const stylesheetUrls = emittedUrls.filter(
      (url) =>
        !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url) &&
        new URL(url, "https://artifact.test").pathname.endsWith(".css"),
    );
    const escapingCssAssetUrls = stylesheetUrls.flatMap((stylesheetUrl) => {
      const stylesheetPath = new URL(stylesheetUrl, "https://artifact.test")
        .pathname;
      const relativeStylesheetPath = stylesheetPath.slice(
        environment.BASE_PATH.length,
      );
      const css = readFileSync(
        path.join(outputDirectory, relativeStylesheetPath),
        "utf8",
      );

      return findEscapingCssAssetUrls(
        css,
        stylesheetUrl,
        environment.BASE_PATH,
      ).map(({ url, resolvedPath }) => ({
        stylesheetUrl,
        url,
        resolvedPath,
      }));
    });

    assert.deepEqual(
      escapingCssAssetUrls,
      [],
      `${name} CSS assets must resolve under ${environment.BASE_PATH}. Found: ${escapingCssAssetUrls
        .map(
          ({ stylesheetUrl, url, resolvedPath }) =>
            `${stylesheetUrl}: ${url} -> ${resolvedPath}`,
        )
        .join(", ")}`,
    );
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

function assertServeModeRequiresEnvironment(
  { name, packageName, artifactDirectory },
  missingVariable,
) {
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    BASE_PATH: readArtifactBasePath(artifactDirectory),
    PORT: "4173",
  };
  delete environment[missingVariable];

  const result = spawnSync("pnpm", ["--filter", packageName, "run", "dev"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const expectedMessage = `${missingVariable} environment variable is required but was not provided.`;

  assert.notEqual(
    result.status,
    0,
    `${name} serve mode must fail when ${missingVariable} is missing.`,
  );
  assert.match(
    output,
    new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `${name} must explain that ${missingVariable} is required.\n${output}`,
  );
}

for (const artifact of artifacts) {
  test(`${artifact.name} production assets follow the artifact preview path`, () => {
    buildWithArtifactRouting(artifact);
  });

  for (const missingVariable of ["PORT", "BASE_PATH"]) {
    test(`${artifact.name} serve mode requires ${missingVariable}`, () => {
      assertServeModeRequiresEnvironment(artifact, missingVariable);
    });
  }
}
