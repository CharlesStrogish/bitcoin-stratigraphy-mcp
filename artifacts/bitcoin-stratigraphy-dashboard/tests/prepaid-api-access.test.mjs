import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const src = "../src/";
const [page, component, hook, app] = await Promise.all([
  readFile(new URL(`${src}pages/developers.tsx`, import.meta.url), "utf8"),
  readFile(new URL(`${src}components/prepaid-api-access.tsx`, import.meta.url), "utf8"),
  readFile(new URL(`${src}lib/use-prepaid-credits.ts`, import.meta.url), "utf8"),
  readFile(new URL(`${src}App.tsx`, import.meta.url), "utf8"),
]);

test("developers advertises B2B credits without importing payments into crawler rendering", () => {
  assert.match(page, /Prepaid API Access \(B2B\)/);
  assert.match(page, /Mint 100 API Credits \(100,000 sats\)/);
  assert.doesNotMatch(page, /import .*prepaid-api-access|import .*api-client-react/);
  assert.match(app, /prepaidAccess=\{<PrepaidApiAccess/);
});

test("only a complete grant reveals the credential with the required warning", () => {
  assert.match(component, /complete && grant &&/);
  assert.match(component, /Copy this Macaroon immediately\. It grants 100 API calls and will not be displayed again\./);
  assert.match(component, /Authorization header as: <code>Macaroon &lt;token&gt;<\/code>/);
  assert.match(component, /value=\{grant\.macaroon\}/);
  assert.doesNotMatch(component, /value=\{challenge\.macaroon\}/);
  assert.match(component, /Success —/);
});

test("funding polls the same capability, validates fixed economics and never persists secrets", () => {
  assert.match(hook, /quote\.amountSats !== 100_000/);
  assert.match(hook, /value\.credits === 100/);
  assert.match(hook, /value\?\.macaroon === quote\.macaroon/);
  assert.match(hook, /request\(`Macaroon \$\{quote\.macaroon\}`\)/);
  assert.match(hook, /setInterval\(tick, 20_000\)/);
  assert.match(hook, /window\.addEventListener\("pagehide", erase\)/);
  assert.match(hook, /controller\.current\?\.abort\(\)/);
  assert.doesNotMatch(hook + component, /localStorage|sessionStorage|console\.|document\.cookie|umami/);
});
