import {
  finalizeEvent,
  nip19,
  SimplePool,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools";

const DEFAULT_API_BASE_URL =
  "https://bitcoin-stratigraphy-dashboard.replit.app";
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
];

function requiredSecretKey(value: string | undefined): Uint8Array {
  if (!value) {
    throw new Error(
      "NOSTR_PRIVATE_KEY is required as a 64-character hex key or nsec",
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Uint8Array.from(Buffer.from(value, "hex"));
  }
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error(
    "NOSTR_PRIVATE_KEY must be a 64-character hex key or valid nsec",
  );
}

function httpsUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
  return url;
}

function relayUrls(value: string | undefined): string[] {
  const candidates = value
    ? value
        .split(",")
        .map((relay) => relay.trim())
        .filter(Boolean)
    : DEFAULT_RELAYS;
  const relays = [...new Set(candidates)];
  if (relays.length === 0) throw new Error("At least one relay is required");
  for (const relay of relays) {
    if (new URL(relay).protocol !== "wss:") {
      throw new Error(`Relay must use wss: ${relay}`);
    }
  }
  return relays;
}

function apiUrls(apiBaseUrl: string) {
  const base = httpsUrl(apiBaseUrl, "NOSTR_API_BASE_URL");
  return {
    base,
    endpoint: new URL("/api/v1/stratigraphy", base).toString(),
    preflightEndpoint: new URL("/api/v1/stratigraphy?days=1", base).toString(),
    openapi: new URL("/openapi.json", base).toString(),
  };
}

async function preflight(endpoint: string, openapi: string) {
  const openapiResponse = await fetch(openapi, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (
    openapiResponse.status !== 200 ||
    !openapiResponse.headers.get("content-type")?.includes("json")
  ) {
    throw new Error(
      `OpenAPI preflight failed: ${openapiResponse.status} ${openapiResponse.headers.get("content-type") ?? "unknown content type"}`,
    );
  }
  const document = (await openapiResponse.json()) as { openapi?: unknown };
  if (typeof document.openapi !== "string") {
    throw new Error(
      "OpenAPI preflight failed: response is not an OpenAPI document",
    );
  }

  const endpointResponse = await fetch(endpoint, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (
    endpointResponse.status !== 402 ||
    !endpointResponse.headers
      .get("www-authenticate")
      ?.toLowerCase()
      .startsWith("l402 ")
  ) {
    throw new Error(
      `L402 endpoint preflight failed: expected a 402 L402 challenge, received ${endpointResponse.status}`,
    );
  }
}

export function buildAnnouncementTemplate(
  apiBaseUrl = DEFAULT_API_BASE_URL,
  createdAt = Math.floor(Date.now() / 1000),
): EventTemplate {
  const { endpoint, openapi } = apiUrls(apiBaseUrl);
  return {
    kind: 1,
    created_at: createdAt,
    content: [
      "Bitcoin Stratigraphy L402 API",
      "",
      "Machine-discoverable HTTP data vending API for date-ranged Bitcoin Stratigraphy records.",
      `Endpoint: ${endpoint}`,
      `OpenAPI: ${openapi}`,
      "Protocol: L402",
      "Pricing: 1 satoshi per requested day; 5 satoshi minimum",
    ].join("\n"),
    tags: [
      ["t", "bitcoin"],
      ["t", "l402"],
      ["t", "openapi"],
      ["t", "api"],
      ["t", "data-vending"],
      ["r", endpoint],
      ["r", openapi],
      ["alt", "Bitcoin Stratigraphy L402 HTTP API announcement"],
    ],
  };
}

export function buildAnnouncement(
  secretKey: Uint8Array,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  createdAt = Math.floor(Date.now() / 1000),
): VerifiedEvent {
  return finalizeEvent(
    buildAnnouncementTemplate(apiBaseUrl, createdAt),
    secretKey,
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const baseUrl = process.env.NOSTR_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const relays = relayUrls(process.env.NOSTR_RELAYS);
  const { endpoint, preflightEndpoint, openapi } = apiUrls(baseUrl);
  if (!dryRun) await preflight(preflightEndpoint, openapi);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          relays,
          // Preview only public, unsigned content; do not load signing secrets.
          event: buildAnnouncementTemplate(baseUrl),
          endpoint,
          openapi,
        },
        null,
        2,
      ),
    );
    return;
  }

  const secretKey = requiredSecretKey(process.env.NOSTR_PRIVATE_KEY);
  const event = buildAnnouncement(secretKey, baseUrl);
  const pool = new SimplePool();
  try {
    const acknowledgements = await Promise.allSettled(
      pool.publish(relays, event, { maxWait: 10_000 }),
    );
    const results = acknowledgements.map((result, index) => ({
      relay: relays[index],
      published: result.status === "fulfilled",
      message:
        result.status === "fulfilled"
          ? result.value
          : result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
    }));
    const published = results.filter((result) => result.published).length;
    console.log(
      JSON.stringify(
        {
          eventId: event.id,
          pubkey: event.pubkey,
          endpoint,
          openapi,
          published,
          attempted: relays.length,
          results,
        },
        null,
        2,
      ),
    );
    if (published === 0) process.exitCode = 1;
  } finally {
    pool.destroy();
  }
}

await main();
