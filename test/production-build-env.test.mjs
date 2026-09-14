import assert from "node:assert/strict";
import TOML from "@iarna/toml";
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

function parseArtifactMetadata(source, filePath, artifactDirectory) {
  try {
    return TOML.parse(source);
  } catch (error) {
    throw new Error(
      `Artifact "${artifactDirectory}" has malformed artifact metadata at ${filePath}: ${error.message}`,
      { cause: error },
    );
  }
}

function readArtifactFile(filePath, artifactDirectory, description) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Artifact "${artifactDirectory}" is missing ${description} at ${filePath}`,
      { cause: error },
    );
  }
}

function readArtifactPackageManifest(filePath, artifactDirectory) {
  const source = readArtifactFile(
    filePath,
    artifactDirectory,
    "package manifest",
  );

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Artifact "${artifactDirectory}" has a malformed package manifest at ${filePath}: ${error.message}`,
      { cause: error },
    );
  }
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
      const artifactConfigPath = path.join(
        artifactsDirectory,
        artifactDirectory,
        ".replit-artifact",
        artifactConfigFilename,
      );
      const artifactConfigSource = readArtifactFile(
        artifactConfigPath,
        artifactDirectory,
        "artifact metadata",
      );
      const artifactMetadata = parseArtifactMetadata(
        artifactConfigSource,
        artifactConfigPath,
        artifactDirectory,
      );
      const kind = artifactMetadata.kind;

      assert.ok(
        kind,
        `Artifact "${artifactDirectory}" must declare kind in artifact metadata at ${artifactConfigPath}`,
      );

      if (!webArtifactKinds.has(kind)) {
        return [];
      }

      const packageManifestPath = path.join(
        artifactsDirectory,
        artifactDirectory,
        "package.json",
      );
      const packageManifest = readArtifactPackageManifest(
        packageManifestPath,
        artifactDirectory,
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
          name: artifactMetadata.title ?? artifactDirectory,
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

test("discovery includes a registered Astro web artifact from dependencies", () => {
  assert.deepEqual(
    discoverFixture("astro-web").map(
      ({ name, packageName, artifactDirectory, buildTool }) => ({
        name,
        packageName,
        artifactDirectory,
        buildTool: buildTool.name,
      }),
    ),
    [
      {
        name: "Fixture Astro App",
        packageName: "@fixtures/astro-web",
        artifactDirectory: "sample",
        buildTool: "Astro",
      },
    ],
  );
});

test("discovery includes a registered Parcel web artifact from devDependencies", () => {
  assert.deepEqual(
    discoverFixture("parcel-web").map(
      ({ name, packageName, artifactDirectory, buildTool }) => ({
        name,
        packageName,
        artifactDirectory,
        buildTool: buildTool.name,
      }),
    ),
    [
      {
        name: "Fixture Parcel Site",
        packageName: "@fixtures/parcel-web",
        artifactDirectory: "sample",
        buildTool: "Parcel",
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

test("discovery rejects an Astro artifact without a package name", () => {
  assert.throws(
    () => discoverFixture("astro-missing-name"),
    /sample must declare a package name/,
  );
});

test("discovery rejects an Astro artifact without a build script", () => {
  assert.throws(
    () => discoverFixture("astro-missing-build"),
    /sample uses Astro and must declare a build script/,
  );
});

test("discovery rejects a Parcel artifact without a package name", () => {
  assert.throws(
    () => discoverFixture("parcel-missing-name"),
    /sample must declare a package name/,
  );
});

test("discovery rejects a Parcel artifact without a build script", () => {
  assert.throws(
    () => discoverFixture("parcel-missing-build"),
    /sample uses Parcel and must declare a build script/,
  );
});

test("discovery identifies an artifact with missing metadata", () => {
  assert.throws(
    () => discoverFixture("missing-metadata"),
    /Artifact "sample" is missing artifact metadata at .*sample.*\.replit-artifact.*fixture\.toml/,
  );
});

test("discovery identifies an artifact with malformed metadata", () => {
  assert.throws(
    () => discoverFixture("malformed-metadata"),
    /Artifact "sample" has malformed artifact metadata at .*sample.*\.replit-artifact.*fixture\.toml:/,
  );
});

test("discovery identifies an artifact metadata file with missing kind", () => {
  assert.throws(
    () => discoverFixture("missing-kind"),
    /Artifact "sample" must declare kind in artifact metadata at .*sample.*\.replit-artifact.*fixture\.toml/,
  );
});

test("discovery identifies an artifact with a missing package manifest", () => {
  assert.throws(
    () => discoverFixture("missing-package"),
    /Artifact "sample" is missing package manifest at .*sample.*package\.json/,
  );
});

test("discovery identifies an artifact with a malformed package manifest", () => {
  assert.throws(
    () => discoverFixture("malformed-package"),
    /Artifact "sample" has a malformed package manifest at .*sample.*package\.json:/,
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

function isExcludedHtmlAssetUrl(url) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);
}

function parseSrcsetUrls(srcset) {
  const urls = [];
  let position = 0;

  while (position < srcset.length) {
    while (/[\s,]/.test(srcset[position] ?? "")) {
      position += 1;
    }

    const urlStart = position;
    while (position < srcset.length && !/\s/.test(srcset[position])) {
      position += 1;
    }

    let url = srcset.slice(urlStart, position);
    const trailingCommas = url.match(/,+$/)?.[0].length ?? 0;
    if (trailingCommas > 0) {
      url = url.slice(0, -trailingCommas);
    }
    if (url) {
      urls.push(url);
    }

    if (trailingCommas === 0) {
      while (position < srcset.length && srcset[position] !== ",") {
        position += 1;
      }
    }
  }

  return urls;
}

function findEscapingHtmlMediaUrls(html, pageUrl, basePath) {
  const mediaAttributes = [
    ["audio", "src"],
    ["embed", "src"],
    ["img", "src"],
    ["input", "src"],
    ["object", "data"],
    ["source", "src"],
    ["track", "src"],
    ["video", "poster"],
    ["video", "src"],
  ];
  const singleUrls = mediaAttributes.flatMap(([tag, attribute]) => [
    ...html.matchAll(
      new RegExp(
        `<${tag}\\b[^>]*\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`,
        "gi",
      ),
    ),
  ]).map((match) => match[2].trim());
  const srcsetUrls = [
    ...html.matchAll(
      /<(?:img|source)\b[^>]*\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    ),
  ].flatMap((match) => parseSrcsetUrls(match[2]));

  return [...singleUrls, ...srcsetUrls]
    .filter((url) => url && !isExcludedHtmlAssetUrl(url))
    .map((url) => ({
      url,
      resolvedPath: new URL(url, pageUrl).pathname,
    }))
    .filter(({ resolvedPath }) => !resolvedPath.startsWith(basePath));
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

function findLocalCssImportUrls(css) {
  return [
    ...css.matchAll(
      /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*))\s*\)|"([^"]*)"|'([^']*)')/gi,
    ),
  ]
    .map((match) =>
      (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]).trim(),
    )
    .filter((url) => url && !isExcludedCssUrl(url));
}

function inspectCssAssetUrls({
  stylesheetUrl,
  basePath,
  readStylesheet,
  visitedStylesheets = new Set(),
}) {
  const resolvedStylesheetUrl = new URL(
    stylesheetUrl,
    "https://artifact.test",
  );
  resolvedStylesheetUrl.hash = "";

  if (visitedStylesheets.has(resolvedStylesheetUrl.href)) {
    return [];
  }
  visitedStylesheets.add(resolvedStylesheetUrl.href);

  const css = readStylesheet(resolvedStylesheetUrl);
  const escapingUrls = findEscapingCssAssetUrls(
    css,
    resolvedStylesheetUrl.href,
    basePath,
  ).map(({ url, resolvedPath }) => ({
    stylesheetUrl: resolvedStylesheetUrl.pathname,
    url,
    resolvedPath,
  }));

  for (const importUrl of findLocalCssImportUrls(css)) {
    const resolvedImportUrl = new URL(importUrl, resolvedStylesheetUrl);

    if (!resolvedImportUrl.pathname.startsWith(basePath)) {
      continue;
    }

    escapingUrls.push(
      ...inspectCssAssetUrls({
        stylesheetUrl: resolvedImportUrl.href,
        basePath,
        readStylesheet,
        visitedStylesheets,
      }),
    );
  }

  return escapingUrls;
}

function findHtmlEntryPoints(directory, relativeDirectory = "") {
  return readdirSync(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      return findHtmlEntryPoints(directory, relativePath);
    }

    return entry.isFile() && entry.name.endsWith(".html") ? [relativePath] : [];
  });
}

const productionOutputFixturesDirectory = path.join(
  workspaceRoot,
  "test",
  "fixtures",
  "production-output",
);

test("HTML entry point discovery includes nested pages", () => {
  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), "production-html-entry-points-"),
  );

  try {
    spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const fs = require('node:fs');",
          `const root = ${JSON.stringify(outputDirectory)};`,
          "fs.mkdirSync(`${root}/guides`, { recursive: true });",
          "fs.writeFileSync(`${root}/index.html`, '');",
          "fs.writeFileSync(`${root}/guides/setup.html`, '');",
          "fs.writeFileSync(`${root}/guides/notes.txt`, '');",
        ].join(""),
      ],
      { encoding: "utf8" },
    );

    assert.deepEqual(
      findHtmlEntryPoints(outputDirectory).sort(),
      ["guides/setup.html", "index.html"],
    );
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});

test("HTML media URLs must resolve within the artifact preview path", () => {
  const html = `
    <img src="./local.png" srcset="./small.png 1x, ../large.png 2x">
    <source src="./clip.webm" srcset="/escaped/clip-2x.webm 2x">
    <img srcset="data:image/svg+xml,%3Csvg%3E 1x, ./inline-fallback.png 2x">
    <video src="../video.mp4" poster="/escaped/poster.jpg"></video>
    <audio src="https://example.com/audio.mp3"></audio>
    <track src="//example.com/captions.vtt">
    <object data="data:image/svg+xml;base64,PHN2Zy8+"></object>
    <embed src="#inline-media">
  `;

  assert.deepEqual(
    findEscapingHtmlMediaUrls(
      html,
      "https://artifact.test/registered/guides/page.html",
      "/registered/",
    ),
    [
      {
        url: "/escaped/poster.jpg",
        resolvedPath: "/escaped/poster.jpg",
      },
      {
        url: "/escaped/clip-2x.webm",
        resolvedPath: "/escaped/clip-2x.webm",
      },
    ],
  );
});

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

test("CSS imports are inspected recursively without loops", () => {
  const stylesheets = new Map([
    [
      "/registered/assets/styles.css",
      `
        @import "./nested/theme.css";
        @import url("https://example.com/external.css");
        @import url(data:text/css,.ignored{});
      `,
    ],
    [
      "/registered/assets/nested/theme.css",
      `
        @import url("../styles.css");
        @font-face { src: url("../fonts/local.woff2") }
        .escaped { background: url("/images/escaped.png") }
      `,
    ],
  ]);
  const reads = [];

  assert.deepEqual(
    inspectCssAssetUrls({
      stylesheetUrl: "/registered/assets/styles.css",
      basePath: "/registered/",
      readStylesheet: ({ pathname }) => {
        reads.push(pathname);
        return stylesheets.get(pathname);
      },
    }),
    [
      {
        stylesheetUrl: "/registered/assets/nested/theme.css",
        url: "/images/escaped.png",
        resolvedPath: "/images/escaped.png",
      },
    ],
  );
  assert.deepEqual(reads, [
    "/registered/assets/styles.css",
    "/registered/assets/nested/theme.css",
  ]);
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

    validateProductionOutput({
      name,
      outputDirectory,
      basePath: environment.BASE_PATH,
      buildTool,
    });
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
}

function validateProductionOutput({
  name,
  outputDirectory,
  basePath,
  buildTool,
}) {
  const htmlEntryPoints = findHtmlEntryPoints(outputDirectory);
  assert.ok(htmlEntryPoints.length > 0, `${name} must emit an HTML entry point`);
  let assetUrlCount = 0;

  for (const htmlEntryPoint of htmlEntryPoints) {
    const html = readFileSync(
      path.join(outputDirectory, htmlEntryPoint),
      "utf8",
    );
    const pageUrl = new URL(
      htmlEntryPoint.split(path.sep).join("/"),
      `https://artifact.test${basePath}`,
    );
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
    assetUrlCount += assetUrls.length;

    assert.ok(
      assetUrls.every((url) =>
        new URL(url, pageUrl).pathname.startsWith(basePath),
      ),
      `${name} assets in ${htmlEntryPoint} must resolve under ${basePath}. Found: ${assetUrls.join(", ")}`,
    );

    const escapingHtmlMediaUrls = findEscapingHtmlMediaUrls(
      html,
      pageUrl,
      basePath,
    );
    assert.deepEqual(
      escapingHtmlMediaUrls,
      [],
      `${name} media referenced by ${htmlEntryPoint} must resolve under ${basePath}. Found: ${escapingHtmlMediaUrls
        .map(({ url, resolvedPath }) => `${url} -> ${resolvedPath}`)
        .join(", ")}`,
    );

    const stylesheetUrls = emittedUrls.filter(
      (url) =>
        !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url) &&
        new URL(url, pageUrl).pathname.endsWith(".css"),
    );
    const visitedStylesheets = new Set();
    const escapingCssAssetUrls = stylesheetUrls.flatMap((stylesheetUrl) =>
      inspectCssAssetUrls({
        stylesheetUrl: new URL(stylesheetUrl, pageUrl).href,
        basePath,
        visitedStylesheets,
        readStylesheet: ({ pathname }) => {
          const relativeStylesheetPath = pathname.slice(basePath.length);
          return readFileSync(
            path.join(outputDirectory, relativeStylesheetPath),
            "utf8",
          );
        },
      }),
    );

    assert.deepEqual(
      escapingCssAssetUrls,
      [],
      `${name} CSS assets referenced by ${htmlEntryPoint} must resolve under ${basePath}. Found: ${escapingCssAssetUrls
        .map(
          ({ stylesheetUrl, url, resolvedPath }) =>
            `${stylesheetUrl}: ${url} -> ${resolvedPath}`,
        )
        .join(", ")}`,
    );
  }

  assert.ok(assetUrlCount > 0, `${name} must emit asset URLs in its HTML`);
}

test("route validation passes a valid multi-page production output", () => {
  assert.doesNotThrow(() =>
    validateProductionOutput({
      name: "Valid multi-page fixture",
      outputDirectory: path.join(productionOutputFixturesDirectory, "valid"),
      basePath: "/registered/",
      buildTool: supportedBuildTools[0],
    }),
  );
});

test("route validation rejects an escaping asset on a secondary page", () => {
  assert.throws(
    () =>
      validateProductionOutput({
        name: "Broken multi-page fixture",
        outputDirectory: path.join(productionOutputFixturesDirectory, "broken"),
        basePath: "/registered/",
        buildTool: supportedBuildTools[0],
      }),
    /Broken multi-page fixture assets in guides[/\\]setup\.html must resolve under \/registered\/.*\/escaped\/assets\/secondary\.js/,
  );
});

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
