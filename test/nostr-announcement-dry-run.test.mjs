import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Nostr announcement dry-run needs no signing key and prints only an unsigned template", () => {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "scripts/broadcast-nostr.ts", "--dry-run",
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    // Intentionally provide no signing key or other workspace credentials.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NOSTR_API_BASE_URL: "https://example.com",
      NOSTR_RELAYS: "wss://relay.example.com",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.relays, ["wss://relay.example.com"]);
  assert.equal(preview.endpoint, "https://example.com/api/v1/stratigraphy");
  assert.equal(preview.openapi, "https://example.com/openapi.json");
  assert.equal(preview.event.kind, 1);
  assert.ok(Number.isInteger(preview.event.created_at));
  assert.match(preview.event.content, /Bitcoin Stratigraphy L402 API/);
  assert.deepEqual(preview.event.tags.filter(([name]) => name === "r"), [
    ["r", preview.endpoint], ["r", preview.openapi],
  ]);
  for (const field of ["sig", "pubkey", "id", "secretKey", "privateKey"]) {
    assert.equal(Object.hasOwn(preview.event, field), false, field);
  }
});