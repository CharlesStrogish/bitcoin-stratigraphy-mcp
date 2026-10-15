import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pinVerifiedSslMode } from "@workspace/db/connection-string";

// The exact parser behind the shared pool: lib/db -> pg -> pg-connection-string.
const dbRequire = createRequire(
  path.resolve(process.cwd(), "../../lib/db/package.json"),
);
const { parse } = createRequire(dbRequire.resolve("pg"))(
  "pg-connection-string",
) as {
  parse(connectionString: string): Record<string, unknown>;
};

const base = "postgresql://app:p%40ss%3Fword@db.example.com:5432/main";
const deprecatedModes = ["prefer", "require", "verify-ca"];

test("modes pg 8 already verifies are spelled out as verify-full", () => {
  for (const mode of deprecatedModes) {
    assert.equal(
      pinVerifiedSslMode(`${base}?sslmode=${mode}&application_name=api`),
      `${base}?sslmode=verify-full&application_name=api`,
    );
  }
});

test("other modes, libpq-compatible URLs and credentials stay byte-identical", () => {
  for (const url of [
    base,
    `${base}?sslmode=disable`,
    `${base}?sslmode=no-verify`,
    `${base}?sslmode=verify-full`,
    `${base}?uselibpqcompat=true&sslmode=require`,
    `${base}?application_name=sslmode=require`,
    "postgresql://app:secret@db.example.com/main#?sslmode=require",
  ]) {
    assert.equal(pinVerifiedSslMode(url), url);
  }
});

test("pinned URLs parse to the same connection and TLS settings without the warning", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  const withoutMode = (config: Record<string, unknown>) => {
    const copy = { ...config };
    delete copy.sslmode;
    return copy;
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  process.on("warning", onWarning);
  try {
    const pinned = deprecatedModes.map((mode) =>
      parse(pinVerifiedSslMode(`${base}?sslmode=${mode}`)),
    );
    await tick();
    assert.deepEqual(warnings, []);
    const original = deprecatedModes.map((mode) =>
      parse(`${base}?sslmode=${mode}`),
    );
    await tick();
    // The detector works: the unpinned form triggers pg's one-time warning.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /treated as aliases for 'verify-full'/);
    for (const [index, config] of pinned.entries()) {
      assert.equal(config.sslmode, "verify-full");
      // Certificate and hostname verification stay on: no rejectUnauthorized=false.
      assert.deepEqual(config.ssl, {});
      assert.deepEqual(withoutMode(config), withoutMode(original[index]!));
    }
  } finally {
    process.off("warning", onWarning);
  }
});
