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
    open_source_license: "AGPLv3 (Viral Network Copyleft under Section 13)",
    commercial_exemption:
      "Required for closed-source model weights, private VPC swarms, and proprietary enterprise logic ($250,000/yr Tier II Commercial Enterprise Exemption)",
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
});
