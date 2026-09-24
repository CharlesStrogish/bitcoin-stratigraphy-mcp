import {
  finalizeEvent,
  nip19,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools";

export const ANNOUNCEMENT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const DVM_NAME = "Bitcoin Stratigraphy Data Engine & ZK Oracle";
export const DVM_ABOUT =
  "Quantitative Bitcoin thermodynamic dataset, Groth16 zk-SNARK state verification, and L402 payment oracle.";
export const DVM_MCP_ENDPOINT =
  "https://bitcoin-stratigraphy-dashboard.replit.app/mcp";
export const NIP90_5050_FEE_SATS = 250;

export type RelayConnectionStatus = {
  relay: string;
  status: "pending" | "connected" | "failed";
  message?: string;
};

export type AnnouncementTransport = {
  publish(event: Event): Promise<void>;
  relayStatuses?(): RelayConnectionStatus[];
};

export type AnnouncementScheduler = {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
};

export type AnnouncerConfig = {
  privateKey: Uint8Array;
  publicKey: string;
  relays: string[];
  stratigraphyFeeSats: number;
  proofFeeSats: number;
  nip05?: string;
  picture?: string;
  banner?: string;
};

export type NostrDiscoveryStatus = {
  public_key: {
    hex: string | null;
    npub: string | null;
  };
  nip05: string | null;
  relays: RelayConnectionStatus[];
  announcement_event_ids: {
    profile: string | null;
    nip89: string[];
  };
  pricing: {
    "5000": { capability: "stratigraphy"; amount_msats: number };
    "5002": { capability: "zk-proof"; amount_msats: number };
    "5050": { capability: "bitcoin-stratigraphy-or-zk"; amount_msats: number };
  };
  last_announced_at: string | null;
  last_attempted_at: string | null;
};

const discoveryStatus: NostrDiscoveryStatus = {
  public_key: { hex: null, npub: null },
  nip05: null,
  relays: [],
  announcement_event_ids: { profile: null, nip89: [] },
  pricing: {
    "5000": { capability: "stratigraphy", amount_msats: 5_000 },
    "5002": { capability: "zk-proof", amount_msats: 21_000 },
    "5050": { capability: "bitcoin-stratigraphy-or-zk", amount_msats: NIP90_5050_FEE_SATS * 1_000 },
  },
  last_announced_at: null,
  last_attempted_at: null,
};

export function getNostrDiscoveryStatus(): NostrDiscoveryStatus {
  return structuredClone(discoveryStatus);
}

export function parseNip05Identifier(
  value: string | undefined,
): { name: string; domain: string; identifier: string } | null {
  if (!value) return null;
  const match = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(
    value.trim(),
  );
  if (!match) {
    throw new Error("NIP-05 identifier must use the form name@example.com");
  }
  const name = match[1]!.toLowerCase();
  const domain = new URL(`https://${match[2]}`).hostname.toLowerCase();
  return { name, domain, identifier: `${name}@${domain}` };
}

export function buildProfileMetadataEvent(
  config: AnnouncerConfig,
  createdAt = Math.floor(Date.now() / 1_000),
): Event {
  const content = {
    name: DVM_NAME,
    about: DVM_ABOUT,
    picture: config.picture ?? "",
    banner: config.banner ?? "",
    ...(config.nip05 ? { nip05: config.nip05 } : {}),
  };
  return finalizeEvent(
    {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify(content),
    },
    config.privateKey,
  );
}

export function buildNip89HandlerEvent(
  config: AnnouncerConfig,
  createdAt = Math.floor(Date.now() / 1_000),
): Event {
  const stratigraphyAmount = String(config.stratigraphyFeeSats * 1_000);
  const proofAmount = String(config.proofFeeSats * 1_000);
  const content = {
    name: DVM_NAME,
    about: DVM_ABOUT,
    author: "Charles R. Strogish",
    architect: "Charles R. Strogish",
    endpoint: DVM_MCP_ENDPOINT,
    mcp_price: "10 sats (discovery), 250 sats (ZK/Data)",
    picture: config.picture ?? "",
    banner: config.banner ?? "",
    capabilities: ["nip-90", "stratigraphy", "zk-proof", "mcp", "l402"],
    jobs: [
      {
        kind: 5_000,
        capability: "stratigraphy",
        amount_msats: Number(stratigraphyAmount),
      },
      {
        kind: 5_002,
        capability: "zk-proof",
        amount_msats: Number(proofAmount),
      },
      {
        kind: 5_050,
        capability: "bitcoin-stratigraphy-or-zk",
        amount_msats: NIP90_5050_FEE_SATS * 1_000,
      },
    ],
  };
  const template: EventTemplate = {
    kind: 31_990,
    created_at: createdAt,
    tags: [
      ["d", "bitcoin-stratigraphy-mcp"],
      ["k", "5000"],
      ["k", "5002"],
      ["k", "5050"],
      ["endpoint", DVM_MCP_ENDPOINT],
      ["price", "10 sats (discovery), 250 sats (ZK/Data)"],
      ["amount", stratigraphyAmount],
      ["amount", proofAmount],
      ["amount", String(NIP90_5050_FEE_SATS * 1_000)],
      ["t", "bitcoin"],
      ["t", "stratigraphy"],
      ["t", "zk"],
      ["t", "zk-proof"],
      ["capability", "nip-90"],
      ["capability", "mcp"],
      ["capability", "l402"],
    ],
    content: JSON.stringify(content),
  };
  return finalizeEvent(template, config.privateKey);
}

const nodeScheduler: AnnouncementScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createServiceAnnouncer(
  config: AnnouncerConfig,
  transport: AnnouncementTransport,
  options: {
    now?: () => number;
    scheduler?: AnnouncementScheduler;
  } = {},
) {
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? nodeScheduler;
  let interval: unknown;
  let stopped = false;
  const activePublishes = new Set<Promise<void>>();

  discoveryStatus.public_key = {
    hex: config.publicKey,
    npub: nip19.npubEncode(config.publicKey),
  };
  discoveryStatus.nip05 = config.nip05 ?? null;
  discoveryStatus.relays = config.relays.map((relay) => ({
    relay,
    status: "pending",
  }));
  discoveryStatus.pricing = {
    "5000": {
      capability: "stratigraphy",
      amount_msats: config.stratigraphyFeeSats * 1_000,
    },
    "5002": {
      capability: "zk-proof",
      amount_msats: config.proofFeeSats * 1_000,
    },
    "5050": {
      capability: "bitcoin-stratigraphy-or-zk",
      amount_msats: NIP90_5050_FEE_SATS * 1_000,
    },
  };

  const track = (promise: Promise<void>) => {
    activePublishes.add(promise);
    void promise.then(
      () => activePublishes.delete(promise),
      () => activePublishes.delete(promise),
    );
    return promise;
  };
  const refreshRelays = () => {
    const statuses = transport.relayStatuses?.();
    if (statuses) discoveryStatus.relays = statuses;
  };
  const publishProfile = async () => {
    const event = buildProfileMetadataEvent(
      config,
      Math.floor(now() / 1_000),
    );
    discoveryStatus.last_attempted_at = new Date(
      event.created_at * 1_000,
    ).toISOString();
    try {
      await transport.publish(event);
      discoveryStatus.announcement_event_ids.profile = event.id;
    } finally {
      refreshRelays();
    }
  };
  const publishHandler = async () => {
    const event = buildNip89HandlerEvent(config, Math.floor(now() / 1_000));
    discoveryStatus.last_attempted_at = new Date(
      event.created_at * 1_000,
    ).toISOString();
    try {
      await transport.publish(event);
      discoveryStatus.announcement_event_ids.nip89 = [
        ...discoveryStatus.announcement_event_ids.nip89.slice(-9),
        event.id,
      ];
      discoveryStatus.last_announced_at = new Date(
        event.created_at * 1_000,
      ).toISOString();
    } finally {
      refreshRelays();
    }
  };

  return {
    async start(): Promise<void> {
      if (interval !== undefined || stopped) return;
      await publishProfile().catch(() => {});
      await publishHandler().catch(() => {});
      if (stopped) return;
      interval = scheduler.setInterval(() => {
        track(publishHandler()).catch(() => {});
      }, ANNOUNCEMENT_INTERVAL_MS);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (interval !== undefined) {
        scheduler.clearInterval(interval);
        interval = undefined;
      }
      await Promise.allSettled([...activePublishes]);
    },
  };
}

export function isValidAnnouncement(event: Event): boolean {
  return verifyEvent(event);
}