import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import {
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from "nostr-tools";
import {
  ANNOUNCEMENT_INTERVAL_MS,
  buildNip89HandlerEvent,
  buildProfileMetadataEvent,
  createServiceAnnouncer,
  DVM_ABOUT,
  DVM_NAME,
  getNostrDiscoveryStatus,
  parseNip05Identifier,
  type AnnouncerConfig,
} from "../artifacts/api-server/src/services/announcer";
import { registerNostrStatusRoute } from "../artifacts/api-server/src/routes/nostr-status";

function config(): AnnouncerConfig {
  const privateKey = generateSecretKey();
  return {
    privateKey,
    publicKey: getPublicKey(privateKey),
    relays: ["wss://relay.one", "wss://relay.two"],
    stratigraphyFeeSats: 5,
    proofFeeSats: 21,
    nip05: "stratigraphy@example.com",
  };
}

test("builds signed Kind 0 DVM profile metadata", () => {
  const input = config();
  const event = buildProfileMetadataEvent(input, 1_800_000_000);
  assert.equal(event.kind, 0);
  assert.equal(event.pubkey, input.publicKey);
  assert.equal(verifyEvent(event), true);
  assert.deepEqual(JSON.parse(event.content), {
    name: DVM_NAME,
    about: DVM_ABOUT,
    picture: "",
    banner: "",
    nip05: "stratigraphy@example.com",
  });
});

test("normalizes valid NIP-05 identities and rejects malformed claims", () => {
  assert.deepEqual(parseNip05Identifier("Stratigraphy@Example.COM"), {
    name: "stratigraphy",
    domain: "example.com",
    identifier: "stratigraphy@example.com",
  });
  assert.throws(
    () => parseNip05Identifier("not-an-identity"),
    /name@example.com/,
  );
});

test("builds signed Kind 31990 metadata with job prices and capabilities", () => {
  const input = config();
  const event = buildNip89HandlerEvent(input, 1_800_000_000);
  assert.equal(event.kind, 31_990);
  assert.equal(event.pubkey, input.publicKey);
  assert.equal(verifyEvent(event), true);
  assert.ok(
    event.tags.some(
      (tag) => tag[0] === "d" && tag[1] === "bitcoin-stratigraphy-mcp",
    ),
  );
  assert.ok(event.tags.some((tag) => tag[0] === "k" && tag[1] === "5000"));
  assert.ok(event.tags.some((tag) => tag[0] === "k" && tag[1] === "5002"));
  assert.ok(event.tags.some((tag) => tag[0] === "k" && tag[1] === "5050"));
  assert.ok(
    event.tags.some(
      (tag) =>
        tag[0] === "endpoint" &&
        tag[1] === "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
    ),
  );
  assert.ok(
    event.tags.some(
      (tag) =>
        tag[0] === "price" &&
        tag[1] === "10 sats (discovery), 250 sats (ZK/Data)",
    ),
  );
  for (const topic of ["bitcoin", "stratigraphy", "zk"]) {
    assert.ok(event.tags.some((tag) => tag[0] === "t" && tag[1] === topic));
  }
  assert.ok(event.tags.some((tag) => tag[0] === "amount" && tag[1] === "5000"));
  assert.ok(
    event.tags.some((tag) => tag[0] === "amount" && tag[1] === "21000"),
  );
  const content = JSON.parse(event.content) as {
    name: string;
    author: string;
    architect: string;
    about: string;
    endpoint: string;
    mcp_price: string;
    capabilities: string[];
    jobs: Array<{ kind: number; amount_msats: number }>;
  };
  assert.equal(content.name, "Bitcoin Stratigraphy Data Engine & ZK Oracle");
  assert.equal(content.author, "Charles R. Strogish");
  assert.equal(content.architect, "Charles R. Strogish");
  assert.equal(
    content.about,
    "Quantitative Bitcoin thermodynamic dataset, Groth16 zk-SNARK state verification, and L402 payment oracle.",
  );
  assert.equal(
    content.endpoint,
    "https://bitcoin-stratigraphy-dashboard.replit.app/mcp",
  );
  assert.equal(content.mcp_price, "10 sats (discovery), 250 sats (ZK/Data)");
  assert.ok(content.capabilities.includes("nip-90"));
  assert.ok(content.capabilities.includes("zk-proof"));
  assert.deepEqual(content.jobs, [
    { kind: 5_000, capability: "stratigraphy", amount_msats: 5_000 },
    { kind: 5_002, capability: "zk-proof", amount_msats: 21_000 },
    {
      kind: 5_050,
      capability: "bitcoin-stratigraphy-or-zk",
      amount_msats: 250_000,
    },
  ]);
});

test("publishes startup announcements and refreshes NIP-89 every six hours", async () => {
  const published: Event[] = [];
  let heartbeat: (() => void) | undefined;
  let intervalMs = 0;
  let now = 1_800_000_000_000;
  const input = config();
  const announcer = createServiceAnnouncer(
    input,
    {
      async publish(event) {
        published.push(event);
      },
      relayStatuses: () =>
        input.relays.map((relay) => ({ relay, status: "connected" as const })),
    },
    {
      now: () => now,
      scheduler: {
        setInterval(callback, milliseconds) {
          heartbeat = callback;
          intervalMs = milliseconds;
          return 1;
        },
        clearInterval() {},
      },
    },
  );
  await announcer.start();
  assert.deepEqual(
    published.map(({ kind }) => kind).sort((a, b) => a - b),
    [0, 31_990],
  );
  assert.equal(intervalMs, ANNOUNCEMENT_INTERVAL_MS);
  now += ANNOUNCEMENT_INTERVAL_MS;
  heartbeat?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.length, 3);
  assert.equal(published[2]!.kind, 31_990);
  assert.ok(
    published[2]!.tags.some((tag) => tag[0] === "k" && tag[1] === "5050"),
  );
  const status = getNostrDiscoveryStatus();
  assert.equal(status.public_key.hex, input.publicKey);
  assert.match(status.public_key.npub!, /^npub1/);
  assert.equal(status.announcement_event_ids.nip89.length, 2);
  assert.deepEqual(
    status.relays.map(({ status: relayStatus }) => relayStatus),
    ["connected", "connected"],
  );
  await announcer.stop();
});

test("does not report a failed heartbeat attempt as an announcement", async () => {
  const input = config();
  let publishes = 0;
  let heartbeat: (() => void) | undefined;
  let now = 1_800_000_000_000;
  const announcer = createServiceAnnouncer(
    input,
    {
      async publish() {
        publishes += 1;
        if (publishes > 2) throw new Error("relay offline");
      },
      relayStatuses: () =>
        input.relays.map((relay) => ({
          relay,
          status: publishes > 2 ? ("failed" as const) : ("connected" as const),
        })),
    },
    {
      now: () => now,
      scheduler: {
        setInterval(callback) {
          heartbeat = callback;
          return 1;
        },
        clearInterval() {},
      },
    },
  );
  await announcer.start();
  const before = getNostrDiscoveryStatus();
  now += ANNOUNCEMENT_INTERVAL_MS;
  heartbeat?.();
  await new Promise((resolve) => setImmediate(resolve));
  const after = getNostrDiscoveryStatus();
  assert.deepEqual(
    after.announcement_event_ids.nip89,
    before.announcement_event_ids.nip89,
  );
  assert.equal(after.last_announced_at, before.last_announced_at);
  assert.notEqual(after.last_attempted_at, before.last_attempted_at);
  assert.ok(after.relays.every(({ status }) => status === "failed"));
  await announcer.stop();
});

test("serves discovery status and binds NIP-05 to its configured domain", async () => {
  const app = express();
  app.set("trust proxy", 1);
  registerNostrStatusRoute(app);
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const info = await fetch(`${baseUrl}/api/v1/nostr/info`);
    assert.equal(info.status, 200);
    const body = (await info.json()) as {
      public_key: { hex: string; npub: string };
      announcement_event_ids: { profile: string; nip89: string[] };
      pricing: Record<string, { amount_msats: number }>;
    };
    assert.match(body.public_key.hex, /^[0-9a-f]{64}$/);
    assert.match(body.public_key.npub, /^npub1/);
    assert.ok(body.announcement_event_ids.profile);
    assert.ok(body.announcement_event_ids.nip89.length > 0);
    assert.equal(body.pricing["5000"]!.amount_msats, 5_000);
    assert.equal(body.pricing["5002"]!.amount_msats, 21_000);
    assert.equal(body.pricing["5050"]!.amount_msats, 250_000);

    const identity = await fetch(
      `${baseUrl}/.well-known/nostr.json?name=stratigraphy`,
      { headers: { "X-Forwarded-Host": "example.com" } },
    );
    assert.equal(identity.status, 200);
    const identityBody = (await identity.json()) as {
      names: Record<string, string>;
    };
    assert.equal(identityBody.names.stratigraphy, body.public_key.hex);

    const wrongDomain = await fetch(
      `${baseUrl}/.well-known/nostr.json?name=stratigraphy`,
      { headers: { "X-Forwarded-Host": "other.example" } },
    );
    assert.equal(wrongDomain.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
