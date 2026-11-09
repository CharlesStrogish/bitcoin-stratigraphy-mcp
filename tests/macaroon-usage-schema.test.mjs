import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("schema synchronization preserves the existing shared macaroon usage table", async () => {
  const [barrel, schema, store] = await Promise.all([
    readFile(new URL("../lib/db/src/schema/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/db/src/schema/macaroon-request-usage.ts", import.meta.url), "utf8"),
    readFile(new URL("../artifacts/api-server/src/lib/postgres-macaroon-usage-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(barrel, /export \* from "\.\/macaroon-request-usage"/);
  assert.match(schema, /pgTable\("macaroon_request_usage"/);
  assert.match(schema, /text\("token_id"\)\.primaryKey\(\)/);
  assert.match(schema, /bigint\("request_count", \{ mode: "bigint" \}\)\.notNull\(\)/);
  assert.match(schema, /timestamp\("expires_at", \{ withTimezone: true \}\)\.notNull\(\)/);
  assert.match(store, /INSERT INTO macaroon_request_usage/);
  assert.doesNotMatch(store, /DROP TABLE|TRUNCATE/i);
});
