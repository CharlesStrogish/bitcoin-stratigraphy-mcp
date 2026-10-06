import assert from "node:assert/strict";

const MCP_URL =
  process.env.MCP_URL ??
  "https://bitcoin-stratigraphy-dashboard.replit.app/mcp";
const RECIPIENT = "0x7a4183ce5b9989833bb33133dcbb8efd6a84e775";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function maskChallenge(value: string): string {
  return value
    .replace(/(macaroon\s*=\s*")[^"]+(")/gi, "$1<redacted>$2")
    .replace(/(invoice\s*=\s*")[^"]+(")/gi, "$1<redacted>$2")
    .replace(/("(?:macaroon|invoice)"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2");
}

async function callTool(
  id: number,
  name: string,
  args: JsonObject = {},
): Promise<{ response: Response; body: JsonObject }> {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${name} returned HTTP ${response.status} with non-JSON body: ${maskChallenge(text).slice(0, 500)}`,
    );
  }
  return { response, body: object(parsed, `${name} response`) };
}

async function checkFreeTool(
  id: number,
  name: string,
  validate: (data: JsonObject) => void,
): Promise<void> {
  const { response, body } = await callTool(id, name);
  assert.equal(
    response.status,
    200,
    `${name} expected HTTP 200; got ${response.status}: ${maskChallenge(JSON.stringify(body))}`,
  );
  assert.equal(
    response.headers.get("www-authenticate"),
    null,
    `${name} returned a payment prompt`,
  );
  assert.equal(
    response.headers.get("payment-required"),
    null,
    `${name} returned an x402 prompt`,
  );
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  assert.equal(body.error, undefined, `${name} returned a JSON-RPC error`);
  const result = object(body.result, `${name} result`);
  const data = object(result.structuredContent, `${name} structuredContent`);
  validate(data);
  console.log(`${name}: HTTP 200 OK, full structured payload:`);
  console.log(JSON.stringify(data, null, 2));
}

async function checkPaidChallenge(): Promise<void> {
  const { response, body } = await callTool(3, "stratigraphy.get", { days: 1 });
  const l402 = response.headers.get("www-authenticate");
  const x402 = response.headers.get("payment-required");
  console.log(`stratigraphy.get: HTTP ${response.status}`);
  console.log(
    "402 headers:",
    JSON.stringify(
      {
        "content-type": response.headers.get("content-type"),
        "www-authenticate": l402 ? maskChallenge(l402) : null,
        "payment-required": x402
          ? `<base64 payload, ${x402.length} chars; decoded below>`
          : null,
      },
      null,
      2,
    ),
  );
  console.log("402 body:", maskChallenge(JSON.stringify(body, null, 2)));

  assert.equal(
    response.status,
    402,
    "Paid tool must return HTTP 402 without authorization",
  );
  assert.ok(l402, "Missing L402 WWW-Authenticate challenge");
  const l402Parts =
    /(?:^|,\s*)L402\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i.exec(l402);
  assert.ok(
    l402Parts?.[1] && l402Parts[2],
    "L402 challenge lacks a macaroon or Lightning invoice",
  );
  assert.ok(
    x402,
    "Missing x402 PAYMENT-REQUIRED challenge (production may not have the new code)",
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(x402, "base64").toString("utf8"));
  } catch {
    throw new Error("PAYMENT-REQUIRED is not base64-encoded JSON");
  }
  const challenge = object(decoded, "x402 challenge");
  const resource = object(challenge.resource, "x402 resource");
  assert.equal(challenge.x402Version, 2, "Expected x402 v2");
  assert.equal(
    resource.url,
    new URL(MCP_URL).href,
    "Challenge resource URL mismatch",
  );
  assert.ok(
    Array.isArray(challenge.accepts),
    "Missing x402 accepted payment terms",
  );
  const accepted = (challenge.accepts as unknown[]).map((entry) =>
    object(entry, "payment terms"),
  );
  const terms = accepted.find(
    (entry) =>
      entry.scheme === "exact" &&
      entry.network === "eip155:8453" &&
      typeof entry.asset === "string" &&
      entry.asset.toLowerCase() === BASE_USDC &&
      typeof entry.payTo === "string" &&
      entry.payTo.toLowerCase() === RECIPIENT &&
      entry.amount === "1000",
  );
  assert.ok(
    terms,
    "No exact Base USDC 0.001 payment to the expected recipient",
  );
  const extra = object(terms.extra, "x402 extra");
  assert.equal(extra.paymentFlow, "upfront", "Expected upfront settlement");
  assert.equal(
    extra.displayAmount,
    "0.001",
    "Expected human-readable 0.001 USDC",
  );
  console.log(
    "Decoded x402 terms:",
    JSON.stringify(
      {
        version: challenge.x402Version,
        resource: resource.url,
        scheme: terms.scheme,
        network: terms.network,
        asset: terms.asset,
        amountAtomicUnits: terms.amount,
        amountUsdc: extra.displayAmount,
        payTo: terms.payTo,
        paymentFlow: extra.paymentFlow,
        settlementAvailable: extra.settlementAvailable !== false,
      },
      null,
      2,
    ),
  );
  console.log("Both L402 and x402 challenges verified; no payment was made.");
}

async function main(): Promise<void> {
  const checks = [
    {
      name: "Free payment.get_info",
      run: () =>
        checkFreeTool(1, "payment.get_info", (data) => {
          assert.ok(
            Array.isArray(data.acceptedPaymentMethods),
            "Missing payment methods",
          );
          assert.ok(
            object(data.perToolSats, "perToolSats")["stratigraphy.list"] === 0,
            "Catalog must be free",
          );
          assert.ok(
            object(data.perToolSats, "perToolSats")["stratigraphy.get"] === 250,
            "Missing paid tool price",
          );
        }),
    },
    {
      name: "Free stratigraphy.list",
      run: () =>
        checkFreeTool(2, "stratigraphy.list", (data) => {
          assert.ok(
            typeof data.totalSnapshots === "number" && data.totalSnapshots > 0,
            "Missing catalog snapshots",
          );
          assert.ok(
            Array.isArray(data.availableMetrics) &&
              data.availableMetrics.length > 0,
            "Missing catalog metrics",
          );
          assert.ok(
            typeof object(data.dateBounds, "dateBounds").startDate === "string",
            "Missing start date",
          );
        }),
    },
    { name: "Paid dual-rail challenge", run: checkPaidChallenge },
  ];
  let failed = 0;
  console.log(`Live MCP test: ${MCP_URL}\n`);
  for (const check of checks) {
    try {
      await check.run();
      console.log(`PASS ${check.name}\n`);
    } catch (error) {
      failed++;
      console.error(
        `FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  console.log(
    `LIVE SUMMARY: ${checks.length - failed}/${checks.length} passed, ${failed} failed`,
  );
  if (failed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(
    "FAIL live test:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
