import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  SimplePool,
  type Event,
  type EventTemplate,
} from "nostr-tools";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readDataset, refreshDataset } from "../routes/stratigraphy";
import { logger } from "./logger";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
] as const;
const DEFAULT_BASE_URL = "https://bitcoin-stratigraphy-dashboard.replit.app";
const KEY_PATH = resolve(
  process.env.NOSTR_EPHEMERAL_KEY_PATH ?? ".data/nostr-heartbeat-private-key",
);

export type NostrHeartbeatStatus = {
  event_id: string | null;
  pubkey: string | null;
  published_at: string | null;
  relays: Array<{
    relay: string;
    status: "pending" | "settled" | "failed";
    message?: string;
  }>;
};

const status: NostrHeartbeatStatus = {
  event_id: null,
  pubkey: null,
  published_at: null,
  relays: RELAYS.map((relay) => ({ relay, status: "pending" })),
};

export function getNostrHeartbeatStatus(): NostrHeartbeatStatus {
  return structuredClone(status);
}

function parseSecret(value: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Uint8Array.from(Buffer.from(value, "hex"));
  }
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error("NOSTR_PRIVATE_KEY must be a 64-character hex key or nsec");
}

async function secretKey(): Promise<Uint8Array> {
  if (process.env.NOSTR_PRIVATE_KEY) {
    return parseSecret(process.env.NOSTR_PRIVATE_KEY);
  }
  try {
    return parseSecret((await readFile(KEY_PATH, "utf8")).trim());
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const generated = generateSecretKey();
  await mkdir(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  await writeFile(KEY_PATH, Buffer.from(generated).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  }).catch(async (error) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  });
  return parseSecret((await readFile(KEY_PATH, "utf8")).trim());
}

export function buildHeartbeatEvent(
  key: Uint8Array,
  datasetHeight: number,
  createdAt = Math.floor(Date.now() / 1000),
  baseUrl = process.env.NOSTR_API_BASE_URL ?? DEFAULT_BASE_URL,
): Event {
  const mcp = new URL("/mcp", baseUrl).toString();
  const cost = new URL("/api/v1/cost", baseUrl).toString();
  const template: EventTemplate = {
    kind: 30078,
    created_at: createdAt,
    tags: [
      ["d", "bitcoin-stratigraphy-heartbeat"],
      ["r", mcp],
      ["r", cost],
      ["t", "l402"],
      ["t", "mcp"],
    ],
    content: JSON.stringify({
      service: "bitcoin-stratigraphy",
      status: "healthy",
      dataset_height: datasetHeight,
      access_tiers: [
        { tier: "1-day", price_sats: 5, endpoint: cost },
        { tier: "30-day", price_sats: 100, endpoint: cost },
      ],
      mcp_endpoint: mcp,
    }),
  };
  return finalizeEvent(template, key);
}

async function publishHeartbeat(key: Uint8Array): Promise<string> {
  const dataset = await readDataset();
  const event = buildHeartbeatEvent(key, dataset.length);
  status.pubkey = getPublicKey(key);
  status.relays = RELAYS.map((relay) => ({ relay, status: "pending" }));
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(
      pool.publish([...RELAYS], event, { maxWait: 10_000 }),
    );
    status.relays = results.map((result, index) => ({
      relay: RELAYS[index],
      status: result.status === "fulfilled" ? "settled" : "failed",
      message:
        result.status === "fulfilled"
          ? result.value
          : result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
    }));
    if (results.some((result) => result.status === "fulfilled")) {
      status.event_id = event.id;
      status.published_at = new Date(event.created_at * 1000).toISOString();
    }
  } finally {
    pool.destroy();
  }
  return createHash("sha256").update(JSON.stringify(dataset)).digest("hex");
}

export async function startNostrHeartbeat(): Promise<() => Promise<void>> {
  const key = await secretKey();
  let datasetHash = await publishHeartbeat(key);
  let stopped = false;
  let activeUpdate: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || activeUpdate) return;
    const update = (async () => {
      const dataset = await refreshDataset();
      const nextHash = createHash("sha256")
        .update(JSON.stringify(dataset))
        .digest("hex");
      if (nextHash !== datasetHash) datasetHash = await publishHeartbeat(key);
    })();
    activeUpdate = update;
    void update
      .catch((error) => {
        logger.warn({ err: error }, "Nostr heartbeat update failed");
      })
      .finally(() => {
        if (activeUpdate === update) activeUpdate = undefined;
      });
  }, 60_000);
  timer.unref();
  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await activeUpdate?.catch(() => {});
  };
}
