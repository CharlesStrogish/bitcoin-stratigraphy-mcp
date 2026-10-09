import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { cp, mkdir, rm } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });
  // Publish an isolated stdlib-only escrow worker; never copy custody DB files.
  for (const [folder, filenames] of [
    ["routers", ["__init__.py", "escrow_api.py", "escrow_worker.py"]],
    ["services", ["__init__.py", "escrow_db.py", "escrow_engine.py"]],
    ["sdk/python/bitcoin_stratigraphy_enterprise", ["__init__.py", "swarm_merkle.py"]],
  ]) {
    const destination = path.resolve(distDir, "escrow-worker", folder);
    await mkdir(destination, { recursive: true });
    for (const filename of filenames) {
      await cp(path.resolve(artifactDir, "../..", folder, filename),
        path.resolve(destination, filename));
    }
  }
  await cp(
    path.resolve(artifactDir, "src/services/zk/artifacts"),
    path.resolve(distDir, "zk/artifacts"),
    { recursive: true },
  );
  await cp(
    path.resolve(artifactDir, "src/public/.well-known"),
    path.resolve(distDir, "public/.well-known"),
    { recursive: true },
  );
  await cp(
    path.resolve(artifactDir, "src/public/docs"),
    path.resolve(distDir, "public/docs"),
    { recursive: true },
  );
  // Only publish the public integration examples, never the workspace itself.
  await mkdir(path.resolve(distDir, "audit-worker/cookbooks"), {
    recursive: true,
  });
  for (const filename of [
    "audit_web_worker.py",
    "audit_verifier.py",
    "audit_verifier_ots.py",
    "article_12_journal.py",
    "_enterprise_compat.py",
  ]) {
    await cp(
      path.resolve(artifactDir, "../../cookbooks", filename),
      path.resolve(distDir, "audit-worker/cookbooks", filename),
    );
  }
  // Keep the isolated audit worker deployable after the enterprise migration.
  // Copy its minimal SDK dependency closure, not journals or the workspace.
  const workerSdkDir = path.resolve(
    distDir,
    "audit-worker/sdk/python/bitcoin_stratigraphy_enterprise",
  );
  await mkdir(workerSdkDir, { recursive: true });
  for (const filename of [
    "__init__.py",
    "audit_verifier.py",
    "audit_verifier_ots.py",
    "article_12_journal.py",
  ]) {
    await cp(
      path.resolve(
        artifactDir,
        "../../sdk/python/bitcoin_stratigraphy_enterprise",
        filename,
      ),
      path.resolve(workerSdkDir, filename),
    );
  }

  await mkdir(path.resolve(distDir, "public/cookbooks"), { recursive: true });
  await cp(
    path.resolve(artifactDir, "src/public/cookbooks/index.html"),
    path.resolve(distDir, "public/cookbooks/index.html"),
  );
  for (const filename of [
    "README.md",
    "requirements.txt",
    "l402_client.py",
    "langchain_example.py",
    "autogen_example.py",
    "crewai_example.py",
  ]) {
    await cp(
      path.resolve(artifactDir, "../../cookbooks", filename),
      path.resolve(distDir, "public/cookbooks", filename),
    );
  }

  // Publish only the standalone, explicitly public framework quickstarts.
  await mkdir(path.resolve(distDir, "public/cookbooks/frameworks"), {
    recursive: true,
  });
  for (const filename of [
    "langchain_agent.py",
    "llamaindex_agent.py",
    "README.md",
    "requirements-langchain.txt",
    "requirements-llamaindex.txt",
  ]) {
    await cp(
      path.resolve(artifactDir, "../../cookbooks/frameworks", filename),
      path.resolve(distDir, "public/cookbooks/frameworks", filename),
    );
  }

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    loader: { ".yaml": "text" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      "snarkjs",
      "poseidon-lite",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] }),
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
