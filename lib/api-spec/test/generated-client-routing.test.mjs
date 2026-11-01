import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("generated fleet and credit clients send exactly one API prefix", async () => {
  const source = await readFile(
    new URL("../../api-client-react/src/generated/api.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\/api\/api(?:\/|[?`"'])/);

  // Run the real TypeScript clients in isolation, without making payments,
  // registering Workers, closing tabs, or sending network requests.
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--eval",
      `
import assert from "node:assert/strict";
import {
  getFleetStatement,
  registerEnterpriseFleet,
  getEnterpriseCreditTab,
  closeEnterpriseCreditTab,
  settleEnterpriseCreditTab,
  getPublicYieldProofs,
} from "./lib/api-client-react/src/generated/api.ts";
import { setBaseUrl } from "./lib/api-client-react/src/custom-fetch.ts";

(async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  };
  const options = { headers: { Authorization: "Nostr routing-test-placeholder" } };
  const registration = { add: [], remove: [] };
  const cases = [
    ["/api/v1/fleet/statement", "GET", () => getFleetStatement(options)],
    ["/api/v1/fleet/register", "POST", () => registerEnterpriseFleet(registration, options)],
    ["/api/v1/enterprise/credit-tab", "GET", () => getEnterpriseCreditTab(options)],
    ["/api/v1/enterprise/credit-tab/close", "POST", () => closeEnterpriseCreditTab(options)],
    ["/api/v1/enterprise/credit-tab/settle", "POST", () => settleEnterpriseCreditTab(options)],
    ["/api/yield-proofs.json", "GET", () => getPublicYieldProofs(options)],
  ];
  for (const base of [null, "https://integrator.example"]) {
    setBaseUrl(base);
    for (const [path, method, invoke] of cases) {
      await invoke();
      const call = calls.at(-1);
      assert.equal(call.url, (base ?? "") + path);
      assert.equal(call.options.method, method);
      assert.equal(new Headers(call.options.headers).get("Authorization"), options.headers.Authorization);
      if (path.endsWith("/fleet/register")) {
        assert.deepEqual(JSON.parse(call.options.body), registration);
      }
    }
  }
  assert.equal(calls.length, cases.length * 2);
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    ],
    {
      cwd: new URL("../../..", import.meta.url),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
});
