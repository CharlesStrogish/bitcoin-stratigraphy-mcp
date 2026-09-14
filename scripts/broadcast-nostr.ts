import {
  finalizeEvent,
  getPublicKey,
  nip19,
  SimplePool,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools";

const DEFAULT_API_BASE_URL =
  "https://bitcoin-stratigraphy-dashboard--charlesstrogish.replit.app";
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
    ? value.split(",").map((relay) => relay.trim()).filter(Boolean)
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

export function buildAnnouncement(
  secretKey: Uint8Array,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  supportedKind = "5000",
  createdAt = Math.floor(Date.now() / 1000),
): VerifiedEvent {
  if (!/^\d+$/.test(supportedKind)) {
    throw new Error("NOSTR_SUPPORTED_KIND must be an integer event kind");
  }

  const base = httpsUrl(apiBaseUrl, "NOSTR_API_BASE_URL");
  const endpoint = new URL("/api/v1/stratigraphy", base).toString();
  const openapi = new URL("/openapi.json", base).toString();
  const pubkey = getPublicKey(secretKey);
  const template: EventTemplate = {
    kind: 31990,
    created_at: createdAt,
    content: JSON.stringify({
      name: "Bitcoin Stratigraphy L402 API",
      about:
        "HTTP data vending API for date-ranged Bitcoin Stratigraphy records. Discover the contract through OpenAPI and purchase responses with L402.",
      website: base.toString(),
      endpoint,
      openapi,
      protocol: "L402",
      transport: "https",
      pricing: "1 satoshi per requested day; 5 satoshi minimum",
      nostr_kind_note:
        "The k tag is a discovery category; requests are made over the documented HTTP API.",
    }),
    tags: [
      ["d", "bitcoin-stratigraphy-l402-api"],
      ["k", supportedKind],
      ["t", "bitcoin"],
      ["t", "l402"],
      ["t", "openapi"],
      ["t", "api"],
      ["r", endpoint],
      ["r", openapi],
      ["web", endpoint],
      ["alt", "Bitcoin Stratigraphy L402 API handler announcement"],
      ["p", pubkey],
    ],
  };

  return finalizeEvent(template, secretKey);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const secretKey = requiredSecretKey(process.env.NOSTR_PRIVATE_KEY);
  const baseUrl = process.env.NOSTR_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const supportedKind = process.env.NOSTR_SUPPORTED_KIND ?? "5000";
  const relays = relayUrls(process.env.NOSTR_RELAYS);
  const event = buildAnnouncement(secretKey, baseUrl, supportedKind);
  const metadata = JSON.parse(event.content) as {
    endpoint: string;
    openapi: string;
  };

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          relays,
          event,
          endpoint: metadata.endpoint,
          openapi: metadata.openapi,
        },
        null,
        2,
      ),
    );
    return;
  }

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
          endpoint: metadata.endpoint,
          openapi: metadata.openapi,
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