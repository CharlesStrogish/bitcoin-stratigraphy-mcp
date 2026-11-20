import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  licensingCompliance,
  attachLicensingCompliance,
  logLicensingSettlement,
} = await tsImport(
  "../artifacts/api-server/src/lib/licensing-compliance.ts",
  import.meta.url,
);
const { quoteMcpTools } = await tsImport(
  "../artifacts/api-server/src/lib/mcp-pricing.ts",
  import.meta.url,
);

test("pre-flight and settlement telemetry share exact machine-readable licensing metadata", () => {
  const expected = {
    terms: licensingCompliance.terms,
    waiver_quote_endpoint: "/api/v1/waivers/quote",
    waiver_claim_endpoint: "/api/v1/waivers/claim",
    waiver_usd_basis: { swarm_monthly: 2500, swarm_annual: 25000, global_monthly: 25000, global_annual: 250000 },
    open_source_license: "AGPLv3 (Viral Network Copyleft under Section 13)",
    commercial_exemption:
      "Self-serve, time-locked AGPLv3 Section 13 Commercial Copyright Waivers; AS-IS, zero SLAs",
    procurement_url: "https://bitcoinstratigraphy.com/#enterprise-licensing",
  };
  assert.deepEqual(licensingCompliance, expected);
  assert.deepEqual(
    quoteMcpTools(["stratigraphy.get"]).licensing_compliance,
    expected,
  );
  const headers = {};
  attachLicensingCompliance({
    setHeader: (key, value) => {
      headers[key] = value;
    },
  });
  assert.deepEqual(
    JSON.parse(headers["X-L402-Licensing-Compliance"]),
    expected,
  );
  const events = [];
  logLicensingSettlement({ log: { info: (event) => events.push(event) } });
  assert.deepEqual(events, [
    { event: "l402_settlement", licensing_compliance: expected },
  ]);
  logLicensingSettlement({});
  logLicensingSettlement({ log: { error() {} } });
});
