import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  SimplePool,
  type Event,
} from "nostr-tools";

const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
] as const;
const DVM_NAME = "Bitcoin Stratigraphy DVM";
const DVM_ABOUT =
  "Autonomous MCP & NIP-90 telemetry data engine providing Bitcoin block stratigraphy and ZK attestation proofs";
const apiRequire = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const { NWCClient } = apiRequire("@getalby/sdk") as {
  NWCClient: new (options: {
    nostrWalletConnectUrl: string;
    logger: Record<"debug" | "info" | "warn" | "error", () => void>;
  }) => {
    payInvoice(input: { invoice: string }): Promise<unknown>;
    lookupInvoice(input: { payment_hash: string }): Promise<unknown>;
    close(): void;
  };
};

const CONTEXT = {
  contextHash:
    "a3f5c1d8e2b4c6a8f1e3d5c7b9a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b6a8",
  agentId: "agent_01",
};

type Challenge = {
  amount_sats: number;
  invoice: string;
  macaroon: string;
  payment_hash: string;
};

type AuditEntry = {
  timestamp: string;
  channel: string;
  requestKind: string;
  satsReceived: number;
  paymentReference: string;
};

function apiBaseUrl(): string {
  const configured = process.env.SIMULATION_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const domain = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (domain) return `https://${domain}`;
  return "http://127.0.0.1:5000";
}

function paymentPreimage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const result = value as {
      preimage?: unknown;
      payment_preimage?: unknown;
    };
    if (typeof result.preimage === "string") return result.preimage;
    if (typeof result.payment_preimage === "string") {
      return result.payment_preimage;
    }
  }
  throw new Error("NWC payInvoice did not return a payment preimage");
}

function optionalPaymentPreimage(value: unknown): string | undefined {
  try {
    const valueCandidate = paymentPreimage(value).toLowerCase();
    return /^[0-9a-f]{64}$/.test(valueCandidate)
      ? valueCandidate
      : undefined;
  } catch {
    return undefined;
  }
}

async function settledPreimage(
  wallet: InstanceType<typeof NWCClient>,
  paymentHash: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const transaction = await wallet.lookupInvoice({
      payment_hash: paymentHash,
    });
    const preimage = optionalPaymentPreimage(transaction);
    if (preimage) return preimage;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    "The invoice settled, but NWC did not expose a valid 32-byte preimage within 30 seconds",
  );
}

function paymentReference(paymentHash: string): string {
  return createHash("sha256")
    .update(paymentHash.toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

function parsePrivateKey(value: string): Uint8Array {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(Buffer.from(value, "hex"));
  }
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error("NOSTR_PRIVATE_KEY must be 64-character hex or nsec");
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  assert.ok(Number.isSafeInteger(value) && value > 0);
  return value;
}

function buildAnnouncements(createdAt: number): [Event, Event] {
  const rawKey = process.env.NOSTR_PRIVATE_KEY?.trim();
  assert.ok(rawKey, "NOSTR_PRIVATE_KEY is required for Nostr re-broadcast");
  const privateKey = parsePrivateKey(rawKey);
  const publicKey = getPublicKey(privateKey);
  const profile = finalizeEvent({
    kind: 0,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify({
      name: DVM_NAME,
      about: DVM_ABOUT,
      picture: process.env.DVM_PICTURE_URL?.trim() ?? "",
      banner: process.env.DVM_BANNER_URL?.trim() ?? "",
      ...(process.env.NIP05_IDENTIFIER?.trim()
        ? { nip05: process.env.NIP05_IDENTIFIER.trim() }
        : {}),
    }),
  }, privateKey);
  const stratigraphyAmount = positiveInteger(
    process.env.DVM_STRATIGRAPHY_FEE_SATS,
    5,
  ) * 1_000;
  const proofAmount = positiveInteger(process.env.DVM_ZK_PROOF_FEE_SATS, 21) *
    1_000;
  const handler = finalizeEvent({
    kind: 31_990,
    created_at: createdAt,
    tags: [
      ["d", "bitcoin-stratigraphy-dvm"],
      ["k", "5000"],
      ["k", "5002"],
      ["amount", String(stratigraphyAmount)],
      ["amount", String(proofAmount)],
      ["t", "stratigraphy"],
      ["t", "zk-proof"],
      ["capability", "nip-90"],
      ["capability", "mcp"],
      ["capability", "l402"],
    ],
    content: JSON.stringify({
      name: DVM_NAME,
      about: DVM_ABOUT,
      picture: process.env.DVM_PICTURE_URL?.trim() ?? "",
      banner: process.env.DVM_BANNER_URL?.trim() ?? "",
      capabilities: ["nip-90", "stratigraphy", "zk-proof", "mcp", "l402"],
      jobs: [
        {
          kind: 5_000,
          capability: "stratigraphy",
          amount_msats: stratigraphyAmount,
        },
        {
          kind: 5_002,
          capability: "zk-proof",
          amount_msats: proofAmount,
        },
      ],
      pubkey: publicKey,
    }),
  }, privateKey);
  return [profile, handler];
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.ok(
    response.ok,
    `${init?.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${text}`,
  );
  return JSON.parse(text) as T;
}

async function publishEventToRelays(
  pool: SimplePool,
  relays: string[],
  event: Event,
) {
  const acknowledgements = await Promise.allSettled(
    pool.publish(relays, event, { maxWait: 10_000 }),
  );
  return acknowledgements.map((result, index) => ({
    relay: relays[index]!,
    delivered: result.status === "fulfilled",
    receipt: result.status === "fulfilled"
      ? result.value
      : result.reason instanceof Error
        ? result.reason.message
        : String(result.reason),
  }));
}

async function rebroadcastNostrAnnouncements() {
  const relays = [...new Set(
    (process.env.NOSTR_RELAYS?.split(",") ?? [...DEFAULT_NOSTR_RELAYS])
      .map((relay) => relay.trim())
      .filter(Boolean),
  )];
  const createdAt = Math.floor(Date.now() / 1_000);
  const [profile, nip89] = buildAnnouncements(createdAt);
  const pool = new SimplePool({ enableReconnect: true });
  try {
    const [profileReceipts, nip89Receipts] = await Promise.all([
      publishEventToRelays(pool, relays, profile),
      publishEventToRelays(pool, relays, nip89),
    ]);
    assert.ok(
      profileReceipts.some(({ delivered }) => delivered),
      "No relay accepted the Kind 0 profile event",
    );
    assert.ok(
      nip89Receipts.some(({ delivered }) => delivered),
      "No relay accepted the Kind 31990 handler event",
    );
    return {
      relays,
      events: [
        { kind: profile.kind, eventId: profile.id, receipts: profileReceipts },
        { kind: nip89.kind, eventId: nip89.id, receipts: nip89Receipts },
      ],
    };
  } finally {
    pool.destroy();
  }
}

async function main() {
  if (process.argv.includes("--nostr-only")) {
    console.log(JSON.stringify({
      nostrRebroadcast: await rebroadcastNostrAnnouncements(),
    }, null, 2));
    return;
  }
  const baseUrl = apiBaseUrl();
  const endpoint = `${baseUrl}/api/v1/zk/ground`;
  const nwcUri = process.env.L402_PAYER_NWC_URI?.trim() ??
    process.env.NWC_URI?.trim();
  assert.ok(
    nwcUri,
    "L402_PAYER_NWC_URI or NWC_URI is required to settle the L402 invoice",
  );

  const beforeRevenue = await jsonRequest<Record<string, unknown>>(
    `${baseUrl}/api/v1/analytics/revenue`,
  );
  const challengeResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(CONTEXT),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const challengeText = await challengeResponse.text();
  assert.equal(
    challengeResponse.status,
    402,
    `Expected an L402 challenge, received HTTP ${challengeResponse.status}: ${challengeText}`,
  );
  const challenge = JSON.parse(challengeText) as Challenge;
  assert.equal(challenge.amount_sats, 5);
  assert.match(challenge.payment_hash, /^[0-9a-f]{64}$/i);

  const wallet = new NWCClient({
    nostrWalletConnectUrl: nwcUri,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });
  let preimage: string;
  try {
    const payment = await wallet.payInvoice({ invoice: challenge.invoice });
    preimage = optionalPaymentPreimage(payment) ??
      await settledPreimage(wallet, challenge.payment_hash);
  } finally {
    wallet.close();
  }
  assert.match(preimage, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex"),
    challenge.payment_hash.toLowerCase(),
    "NWC preimage does not match the challenged payment hash",
  );

  const paid = await jsonRequest<{
    receipt: {
      contextHash: string;
      blockHeight: number;
      merkleRoot: string;
      timestamp: number;
      nostrSignature: unknown;
    };
  }>(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `L402 ${challenge.macaroon}:${preimage}`,
    },
    body: JSON.stringify(CONTEXT),
  });
  assert.equal(paid.receipt.contextHash, CONTEXT.contextHash);

  const [afterRevenue, audit, nostr] = await Promise.all([
    jsonRequest<Record<string, unknown>>(
      `${baseUrl}/api/v1/analytics/revenue`,
    ),
    jsonRequest<{ transactions: AuditEntry[] }>(
      `${baseUrl}/api/v1/analytics/audit?limit=100`,
    ),
    rebroadcastNostrAnnouncements(),
  ]);
  const reference = paymentReference(challenge.payment_hash);
  const ledgerEntry = audit.transactions.find(
    (entry) =>
      entry.paymentReference === reference &&
      entry.channel === "L402" &&
      entry.requestKind === "zk-proof" &&
      entry.satsReceived === 5,
  );
  assert.ok(ledgerEntry, "The 5-sat zk-proof ledger entry was not found");

  console.log(JSON.stringify({
    simulation: {
      endpoint,
      challengeAmountSats: challenge.amount_sats,
      paymentHashVerified: true,
      settlementRecorded: true,
      paymentReference: reference,
    },
    epistemicAnchorReceipt: paid.receipt,
    revenue: {
      before: beforeRevenue,
      after: afterRevenue,
      matchedLedgerEntry: ledgerEntry,
    },
    nostrRebroadcast: nostr,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : error,
  );
  process.exitCode = 1;
});