import assert from "node:assert/strict";

const DEFAULT_L402_URL =
  "https://bitcoin-stratigraphy-dashboard.replit.app/api/v1/stratigraphy";
const PREIMAGE_PATTERN = /^[0-9a-fA-F]{64}$/;

type L402Challenge = {
  macaroon: string;
  invoice: string;
};

function parseChallenge(header: string): L402Challenge {
  const match =
    /(?:^|,\s*)L402\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i.exec(header);
  assert.ok(
    match,
    `WWW-Authenticate did not contain an L402 macaroon/invoice challenge: ${header}`,
  );
  return { macaroon: match[1], invoice: match[2] };
}

async function requestChallenge(url: string): Promise<L402Challenge> {
  console.log(`Requesting L402 challenge from ${url}`);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });

  assert.equal(
    response.status,
    402,
    `Expected HTTP 402 Payment Required, received ${response.status} ${response.statusText}: ${await response.text()}`,
  );

  const authenticate = response.headers.get("www-authenticate");
  assert.ok(authenticate, "HTTP 402 response is missing WWW-Authenticate");
  const challenge = parseChallenge(authenticate);

  console.log("\nL402 challenge verified.");
  console.log(`Macaroon token: ${challenge.macaroon}`);
  console.log(`BOLT11 Lightning invoice: ${challenge.invoice}`);
  return challenge;
}

async function verifySettlement(
  url: string,
  challenge: L402Challenge,
  preimage: string,
) {
  assert.match(
    preimage,
    PREIMAGE_PATTERN,
    "Preimage must be exactly 64 hexadecimal characters (32 bytes)",
  );

  console.log("\nReissuing the request with the L402 payment proof...");
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `L402 ${challenge.macaroon}:${preimage.toLowerCase()}`,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();

  assert.equal(
    response.status,
    200,
    `Expected HTTP 200 OK after settlement, received ${response.status} ${response.statusText}: ${body}`,
  );
  assert.ok(body.length > 0, "Paid endpoint returned an empty payload");

  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown = body;
  if (contentType.includes("json")) {
    payload = JSON.parse(body) as unknown;
    assert.ok(payload !== null, "Paid endpoint returned a null JSON payload");
  }

  console.log("\nL402 settlement verified: received HTTP 200 OK.");
  console.log("Paid response payload:");
  console.dir(payload, { depth: 5, maxArrayLength: 10 });
}

async function main() {
  const url = process.env.L402_URL ?? DEFAULT_L402_URL;
  const preimage = process.argv[2];
  const challenge = await requestChallenge(url);

  if (!preimage) {
    console.log(
      "\nSettle this raw BOLT11 invoice with a Lightning wallet or NWC:",
    );
    console.log(challenge.invoice);
    console.log("\nAfter settlement, verify the payment with:");
    console.log("npm run test:l402 -- <64-character-hex-preimage>");
    console.log(
      "\nTo target another deployment or route, set L402_URL to its full paid endpoint URL.",
    );
    return;
  }

  await verifySettlement(url, challenge, preimage);
}

main().catch((error: unknown) => {
  console.error("\nL402 flow verification failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
