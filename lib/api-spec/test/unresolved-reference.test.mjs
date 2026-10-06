import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("validation rejects an unresolved internal reference", () => {
  const result = spawnSync(
    "pnpm",
    [
      "run",
      "validate:spec",
      "test/fixtures/invalid-unresolved-reference.openapi.yaml",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );

  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /DefinitelyMissingSchema/);
  assert.match(output, /resolve|unresolved|exist/i);
});
