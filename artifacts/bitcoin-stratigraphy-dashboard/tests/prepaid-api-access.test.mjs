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
  assert.match(page, /Mint 100 API Credits \(\$450 in BTC\)/);
  assert.doesNotMatch(page, /100,000 sats/);
  assert.doesNotMatch(page, /import .*prepaid-api-access|import .*api-client-react/);
  assert.match(app, /prepaidAccess=\{<PrepaidApiAccess/);
});

test("only a complete grant reveals the credential with the required warning", () => {
  assert.match(component, /complete && grant &&/);
  assert.match(component, /Copy this Macaroon immediately\. It grants \{grant\.credits\.toLocaleString\("en-US"\)\} API calls and will not be displayed again\./);
  assert.match(component, /data-testid=\{`radio-pack-\$\{key\}`\}/);
  assert.match(component, /Authorization header as: <code>Macaroon &lt;token&gt;<\/code>/);
  assert.match(component, /value=\{grant\.macaroon\}/);
  assert.doesNotMatch(component, /value=\{challenge\.macaroon\}/);
  assert.match(component, /Success —/);
});

test("funding polls the same capability, validates quote-bound pack economics and never persists secrets", () => {
  assert.doesNotMatch(hook, /100_000/);
  assert.match(hook, /standard: \{ credits: 100, usd: 450, days: 30/);
  assert.match(hook, /heavy_swarm_1000: \{ credits: 1000, usd: 4000, days: 90/);
  assert.match(hook, /body\.credits !== product\.credits/);
  assert.match(hook, /value\.credits === quote\.credits/);
  assert.match(hook, /value\.amount_sats === quote\.amountSats/);
  assert.match(hook, /value\?\.macaroon === quote\.macaroon/);
  assert.match(hook, /request\(quote\.pack, `Macaroon \$\{quote\.macaroon\}`\)/);
  assert.match(hook, /selected === "standard" \? \{\} : \{ pack: selected \}/);
  assert.match(hook, /setInterval\(tick, 20_000\)/);
  assert.match(hook, /window\.addEventListener\("pagehide", erase\)/);
  assert.match(hook, /controller\.current\?\.abort\(\)/);
  assert.doesNotMatch(hook + component, /localStorage|sessionStorage|console\.|document\.cookie|umami/);
});
