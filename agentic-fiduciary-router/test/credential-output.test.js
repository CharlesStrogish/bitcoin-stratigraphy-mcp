import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Public synthetic fixtures, never production credentials or usable endpoints.
const mockUri = `nostr+walletconnect://${"1".repeat(64)}?relay=wss%3A%2F%2Frelay.invalid&secret=${"2".repeat(64)}`;
const mockOperator = "mock-fiduciary-audit-operator-not-a-real-secret";

test("mock environment initializes the router without network access or credential output", () => {
  // CI must inject the intended mock values, not repository/wallet secrets.
  if (process.env.FIDUCIARY_AUDIT_MOCKS === "1") {
    assert.ok(process.env.NWC_URI === mockUri, "CI must use the synthetic NWC fixture");
    assert.ok(process.env.OPERATOR_SECRET === mockOperator, "CI must use the synthetic operator fixture");
  }
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { BitcoinStratigraphyRouter } from "./index.js";
    globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
    globalThis.WebSocket = class {
      constructor() { throw new Error("NETWORK_FORBIDDEN"); }
    };
    const router = new BitcoinStratigraphyRouter({
      nwcUri: process.env.NWC_URI,
      maxPaymentSats: 100,
      maxTotalSats: 1000,
      fetch: async request => {
        const headers = JSON.stringify([...request.headers]);
        assert.ok(!headers.includes(process.env.OPERATOR_SECRET));
        assert.ok(!headers.includes(process.env.NWC_URI));
        assert.ok(!headers.includes(new URL(process.env.NWC_URI).searchParams.get("secret")));
        return new Response('{"free":true}', {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const response = await router.fetch("https://bitcoinstratigraphy.com/mcp");
    assert.equal(response.status, 200);
    await router.drain();
    let rejected = false;
    try {
      new BitcoinStratigraphyRouter({
        nwcUri: process.env.OPERATOR_SECRET,
        maxPaymentSats: 100,
        maxTotalSats: 1000,
      });
    } catch (error) {
      rejected = true;
      assert.equal(error.message, "INVALID_NWC_URI");
    }
    assert.ok(rejected);
    console.log("L402 routing initialization and credential isolation checks passed.");
  `], {
    cwd: new URL("../", import.meta.url),
    // Do not inherit the developer's environment, wallet or operator secrets.
    env: { NWC_URI: mockUri, OPERATOR_SECRET: mockOperator },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  for (const value of [mockUri, mockOperator, "2".repeat(64)]) {
    assert.ok(!output.includes(value), "Subprocess output must not contain mock credentials");
  }
  assert.ok(!child.error, "Initialization subprocess must complete");
  assert.equal(child.status, 0, "Initialization and credential isolation must succeed");
  assert.match(output, /L402 routing initialization and credential isolation checks passed/);
});
