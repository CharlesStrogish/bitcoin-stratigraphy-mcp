import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/components/fiat-mint-checkout.tsx", import.meta.url),
  "utf8",
);

test("checkout clears its opening state even if navigation does not complete", () => {
  const checkout = source.slice(
    source.indexOf("async function checkout()"),
    source.indexOf("async function claim()"),
  );
  assert.match(
    checkout,
    /finally\s*\{\s*if \(alive\.current\) setBusy\(false\)/,
  );
  assert.match(checkout, /refresh\(\{ preserveError: true \}\)/);
  assert.match(source, /if \(!preserveError\) setError\(""\)/);
  assert.match(source, /signal: AbortSignal\.timeout\(25_000\)/);
});
