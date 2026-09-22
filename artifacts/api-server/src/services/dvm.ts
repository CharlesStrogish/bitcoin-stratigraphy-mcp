import { createHash, randomUUID } from "node:crypto";
import {
  finalizeEvent,
  getPublicKey,
  SimplePool,
  verifyEvent,
  type Event,
  type EventTemplate,
  type Filter,
} from "nostr-tools";
import { logger } from "../lib/logger";
import {
  DEFAULT_NOSTR_RELAYS,
  parsePrivateKey,
} from "./nostrAttestation";
import {
  createDefaultSettlementRouter,
  createNwcClient,
  type NwcClientFactory,
  type SettlementInvoice,
} from "./settlement";
import {
  createServiceAnnouncer,
  parseNip05Identifier,
  type RelayConnectionStatus,
} from "./announcer";
import {
  paymentReference,
  recordRevenueWithRetry,
  type RevenueLedger,
} from "./ledger";

const JOB_REQUEST_KINDS = Array.from({ length: 991 }, (_, index) => 5_000 + index);
const DEFAULT_INVOICE_EXPIRY_SECONDS = 3_600;
const DEFAULT_SETTLEMENT_POLL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT_JOBS = 4;
const DEFAULT_MAX_PENDING_PAYMENTS = 32;
const MAX_SEEN_REQUESTS = 10_000;

type DvmCapability = "stratigraphy" | "zk-proof";
type DvmFeedbackStatus =
  | "payment-required"
  | "processing"
  | "success"
  | "error";

export type DvmConfig = {
  privateKey: Uint8Array;
  publicKey: string;
  relays: string[];
  stratigraphyFeeSats: number;
  proofFeeSats: number;
  invoiceExpirySeconds: number;
  settlementPollMs: number;
  maxConcurrentJobs: number;
  maxPendingPayments: number;
};

export type DvmTransport = {
  subscribe(filter: Filter, onEvent: (event: Event) => void): () => void;
  publish(event: Event): Promise<void>;
  relayStatuses?(): RelayConnectionStatus[];
  close(): void;
};

type DvmInvoice = SettlementInvoice & {
  amountMsats: number;
  description: string;
};

export type DvmDependencies = {
  transport?: DvmTransport;
  createInvoice?: (input: {
    amountMsats: number;
    description: string;
    expirySeconds: number;
    signal: AbortSignal;
  }) => Promise<SettlementInvoice>;
  waitForSettlement?: (
    invoice: DvmInvoice,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<DvmSettlementConfirmation | false>;
  queryStratigraphy?: (input: Record<string, unknown>) => Promise<unknown>;
  verifyProof?: (input: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
  ledger?: RevenueLedger;
};

export type DvmSettlementConfirmation = {
  settledAt: number;
  preimage: string;
};

export type Nip90Dvm = {
  start(): void;
  stop(): Promise<void>;
  handleEvent(event: Event): Promise<void>;
};

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function relayList(raw: string | undefined): string[] {
  const relays = (raw?.split(",") ?? [...DEFAULT_NOSTR_RELAYS])
    .map((relay) => relay.trim())
    .filter(Boolean);
  if (relays.length === 0) {
    throw new Error("NOSTR_RELAYS must contain at least one relay URL");
  }
  for (const relay of relays) {
    const parsed = new URL(relay);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      throw new Error(`NOSTR_RELAYS contains a non-WebSocket URL: ${relay}`);
    }
  }
  return [...new Set(relays)];
}

export function loadDvmConfig(
  env: NodeJS.ProcessEnv = process.env,
): DvmConfig {
  const configuredKey = env.NOSTR_PRIVATE_KEY?.trim();
  if (!configuredKey) {
    throw new Error("NOSTR_PRIVATE_KEY is required for the NIP-90 DVM");
  }
  const privateKey = parsePrivateKey(configuredKey);
  return {
    privateKey,
    publicKey: getPublicKey(privateKey),
    relays: relayList(env.NOSTR_RELAYS),
    stratigraphyFeeSats: positiveInteger(
      env.DVM_STRATIGRAPHY_FEE_SATS,
      5,
      "DVM_STRATIGRAPHY_FEE_SATS",
    ),
    proofFeeSats: positiveInteger(
      env.DVM_ZK_PROOF_FEE_SATS,
      21,
      "DVM_ZK_PROOF_FEE_SATS",
    ),
    invoiceExpirySeconds: positiveInteger(
      env.DVM_INVOICE_EXPIRY_SECONDS,
      DEFAULT_INVOICE_EXPIRY_SECONDS,
      "DVM_INVOICE_EXPIRY_SECONDS",
    ),
    settlementPollMs: positiveInteger(
      env.DVM_SETTLEMENT_POLL_MS,
      DEFAULT_SETTLEMENT_POLL_MS,
      "DVM_SETTLEMENT_POLL_MS",
    ),
    maxConcurrentJobs: positiveInteger(
      env.DVM_MAX_CONCURRENT_JOBS,
      DEFAULT_MAX_CONCURRENT_JOBS,
      "DVM_MAX_CONCURRENT_JOBS",
    ),
    maxPendingPayments: positiveInteger(
      env.DVM_MAX_PENDING_PAYMENTS,
      DEFAULT_MAX_PENDING_PAYMENTS,
      "DVM_MAX_PENDING_PAYMENTS",
    ),
  };
}

export function createNostrDvmTransport(
  relays: string[],
  pool = new SimplePool({ enableReconnect: true }),
): DvmTransport {
  const abortController = new AbortController();
  const relayStatus = new Map<string, RelayConnectionStatus>(
    relays.map((relay) => [relay, { relay, status: "pending" }]),
  );
  return {
    subscribe(filter, onEvent) {
      const subscription = pool.subscribeMany(relays, filter, {
        onevent: onEvent,
        abort: abortController.signal,
      });
      return () => subscription.close("DVM stopped");
    },
    async publish(event) {
      const outcomes = await Promise.allSettled(
        pool.publish(relays, event, {
          maxWait: 5_000,
          abort: abortController.signal,
        }),
      );
      outcomes.forEach((outcome, index) => {
        const relay = relays[index]!;
        relayStatus.set(
          relay,
          outcome.status === "fulfilled"
            ? { relay, status: "connected" }
            : {
                relay,
                status: "failed",
                message:
                  outcome.reason instanceof Error
                    ? outcome.reason.message
                    : String(outcome.reason),
              },
        );
      });
      if (!outcomes.some((outcome) => outcome.status === "fulfilled")) {
        throw new Error("No configured Nostr relay accepted the DVM event");
      }
    },
    relayStatuses() {
      return relays.map((relay) => ({ ...relayStatus.get(relay)! }));
    },
    close() {
      abortController.abort();
      pool.destroy();
    },
  };
}

function walletUri(provider: string): string | undefined {
  if (provider === "coinos") return process.env.NWC_URI?.trim() || undefined;
  if (provider === "alby") {
    return (
      process.env.ALBY_NWC_URI?.trim() ||
      process.env.NWC_FALLBACK_URI?.trim() ||
      undefined
    );
  }
  return undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("DVM settlement wait aborted"));
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error("DVM settlement wait aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createNwcSettlementWaiter(
  clientFactory: NwcClientFactory = createNwcClient,
  pollMs = DEFAULT_SETTLEMENT_POLL_MS,
) {
  return async (
    invoice: DvmInvoice,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<DvmSettlementConfirmation | false> => {
    const uri = walletUri(invoice.provider);
    if (!uri) {
      throw new Error(
        `No NWC URI is configured for settlement provider ${invoice.provider}`,
      );
    }
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (options.signal.aborted) return false;
      const client = clientFactory(uri);
      try {
        const transaction = await client.lookupInvoice({
          payment_hash: invoice.paymentHash,
        });
        if (
          transaction.type === "incoming" &&
          transaction.state === "settled" &&
          transaction.amount === invoice.amountMsats &&
          transaction.description === invoice.description &&
          transaction.payment_hash.toLowerCase() === invoice.paymentHash
        ) {
          if (!/^[0-9a-f]{64}$/i.test(transaction.preimage)) return false;
          const preimageHash = createHash("sha256")
            .update(Buffer.from(transaction.preimage, "hex"))
            .digest("hex");
          if (preimageHash !== invoice.paymentHash) return false;
          return {
            settledAt: transaction.settled_at,
            preimage: transaction.preimage.toLowerCase(),
          };
        }
        if (transaction.state === "failed") {
          return false;
        }
      } finally {
        client.close();
      }
      await delay(
        Math.min(pollMs, Math.max(1, deadline - Date.now())),
        options.signal,
      );
    }
    return false;
  };
}

function capabilityFor(event: Event): DvmCapability | undefined {
  const topics = event.tags
    .filter((tag) => tag[0] === "t")
    .map((tag) => tag[1]?.toLowerCase());
  if (event.kind === 5_002 || topics.includes("zk-proof")) return "zk-proof";
  if (
    event.kind === 5_000 ||
    event.kind === 5_001 ||
    topics.includes("stratigraphy")
  ) {
    return "stratigraphy";
  }
  return undefined;
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function parseDvmRequest(event: Event): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (event.content.trim()) {
    const parsed = parseValue(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(payload, parsed);
    }
  }
  for (const tag of event.tags) {
    if (tag[0] === "param" && tag[1] && tag[2] !== undefined) {
      payload[tag[1]] = parseValue(tag[2]);
    }
  }
  const inputTags = event.tags.filter(
    (tag) =>
      tag[0] === "i" &&
      tag[1] !== undefined &&
      (tag[2] === "text" || tag[2] === "url"),
  );
  const textInputs = inputTags.filter((tag) => tag[2] === "text");
  if (textInputs.length === 1) {
    const parsed = parseValue(textInputs[0]![1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(payload, parsed);
    } else {
      payload.input = parsed;
    }
  } else if (textInputs.length > 1) {
    payload.inputs = textInputs.map((tag) => parseValue(tag[1]!));
  }
  const urlInputs = inputTags.filter((tag) => tag[2] === "url");
  if (urlInputs.length === 1) {
    payload.url = urlInputs[0]![1]!;
  } else if (urlInputs.length > 1) {
    payload.urls = urlInputs.map((tag) => tag[1]!);
  }
  return payload;
}

async function defaultStratigraphyQuery(input: Record<string, unknown>) {
  const { getStratigraphyData } = await import("../routes/stratigraphy");
  const recentDays = input.recentDays ?? input.days;
  const days =
    typeof recentDays === "number" && Number.isInteger(recentDays)
      ? recentDays
      : undefined;
  const date = typeof input.date === "string" ? input.date : undefined;
  const from = typeof input.from === "string" ? input.from : undefined;
  if ([days, date, from].filter((value) => value !== undefined).length > 1) {
    throw new RangeError("Provide only one of recentDays/days, date, or from");
  }
  return {
    records: await getStratigraphyData({ days, date, from }),
  };
}

async function defaultProofVerification(input: Record<string, unknown>) {
  const { verifyZkProof, verifyZkProofForSnapshot } = await import(
    "./zkProofService"
  );
  const startedAt = performance.now();
  const valid = input.data === undefined
    ? await verifyZkProof(input)
    : await verifyZkProofForSnapshot(input, input.data);
  return {
    valid,
    verifiedAt: new Date().toISOString(),
    computationTimeMs: Number((performance.now() - startedAt).toFixed(3)),
  };
}

function requestedBid(event: Event): number | undefined {
  const raw = event.tags.find((tag) => tag[0] === "bid")?.[1];
  if (raw === undefined) return undefined;
  const bid = Number(raw);
  return Number.isSafeInteger(bid) && bid >= 0 ? bid : undefined;
}

export function createNip90Dvm(
  config = loadDvmConfig(),
  dependencies: DvmDependencies = {},
): Nip90Dvm {
  const transport =
    dependencies.transport ?? createNostrDvmTransport(config.relays);
  const settlementRouter = createDefaultSettlementRouter();
  const createInvoice =
    dependencies.createInvoice ??
    ((input) => settlementRouter.createInvoice(input));
  const waitForSettlement =
    dependencies.waitForSettlement ??
    createNwcSettlementWaiter(undefined, config.settlementPollMs);
  const queryStratigraphy =
    dependencies.queryStratigraphy ?? defaultStratigraphyQuery;
  const verifyProof = dependencies.verifyProof ?? defaultProofVerification;
  const now = dependencies.now ?? Date.now;
  const ledger = dependencies.ledger;
  const abortController = new AbortController();
  const seen = new Map<string, number>();
  const activeJobs = new Set<Promise<void>>();
  let executingJobs = 0;
  let pendingPayments = 0;
  let closeSubscription: (() => void) | undefined;
  let running = false;

  const signedEvent = (
    kind: number,
    content: string,
    tags: string[][],
  ): Event =>
    finalizeEvent(
      {
        kind,
        content,
        tags,
        created_at: Math.floor(now() / 1_000),
      },
      config.privateKey,
    );

  const publishFeedback = async (
    request: Event,
    status: DvmFeedbackStatus,
    content = "",
    invoice?: DvmInvoice,
  ) => {
    const tags = [
      content ? ["status", status, content] : ["status", status],
      ["e", request.id],
      ["p", request.pubkey],
    ];
    if (invoice) {
      tags.push(["amount", String(invoice.amountMsats), invoice.invoice]);
    }
    await transport.publish(signedEvent(7_000, content, tags));
  };

  const publishResult = async (
    request: Event,
    result: unknown,
    invoice: DvmInvoice,
  ) => {
    await transport.publish(
      signedEvent(request.kind + 1_000, JSON.stringify(result), [
        ["request", JSON.stringify(request)],
        ["e", request.id],
        ["p", request.pubkey],
        ["amount", String(invoice.amountMsats), invoice.invoice],
      ]),
    );
  };

  const processRequest = async (
    request: Event,
    capability: DvmCapability,
  ) => {
    const feeSats = capability === "stratigraphy"
      ? config.stratigraphyFeeSats
      : config.proofFeeSats;
    const amountMsats = feeSats * 1_000;
    const bid = requestedBid(request);
    if (bid !== undefined && bid < amountMsats) {
      await publishFeedback(
        request,
        "error",
        `Bid ${bid} msats is below the required fee of ${amountMsats} msats`,
      );
      return;
    }
    const description = `Bitcoin Stratigraphy NIP-90 ${capability} job ${request.id}`;
    pendingPayments += 1;
    let invoice: DvmInvoice;
    let settlement: DvmSettlementConfirmation | false;
    try {
      const created = await createInvoice({
        amountMsats,
        description,
        expirySeconds: config.invoiceExpirySeconds,
        signal: abortController.signal,
      });
      invoice = { ...created, amountMsats, description };
      await publishFeedback(request, "payment-required", "", invoice);
      settlement = await waitForSettlement(invoice, {
        signal: abortController.signal,
        timeoutMs: config.invoiceExpirySeconds * 1_000,
      });
    } finally {
      pendingPayments -= 1;
    }
    if (!settlement) {
      await publishFeedback(
        request,
        "error",
        "Lightning invoice expired or was not settled",
      );
      return;
    }
    if (ledger) {
      try {
        await recordRevenueWithRetry(ledger, {
          id: randomUUID(),
          timestamp: new Date(
            settlement.settledAt < 10_000_000_000
              ? settlement.settledAt * 1_000
              : settlement.settledAt,
          ).toISOString(),
          channel: "NIP-90",
          requestKind: capability,
          satsReceived: feeSats,
          paymentHash: invoice.paymentHash,
          preimage: settlement.preimage,
          clientIdentifier: request.pubkey,
        });
      } catch (error) {
        logger.error(
          {
            err: error,
            paymentReference: paymentReference(invoice.paymentHash),
          },
          "NIP-90 settlement ledger failed",
        );
      }
    }
    while (executingJobs >= config.maxConcurrentJobs) {
      await delay(25, abortController.signal);
    }
    executingJobs += 1;
    await publishFeedback(request, "processing");
    try {
      const input = parseDvmRequest(request);
      const result = capability === "stratigraphy"
        ? await queryStratigraphy(input)
        : await verifyProof(input);
      await publishResult(request, result, invoice);
      await publishFeedback(request, "success");
    } finally {
      executingJobs -= 1;
    }
  };

  const handleEvent = async (event: Event) => {
    if (!running || abortController.signal.aborted) return;
    if (event.kind < 5_000 || event.kind > 5_990) return;
    const currentTime = now();
    const seenUntil = seen.get(event.id);
    if (seenUntil !== undefined) {
      if (seenUntil > currentTime) return;
      seen.delete(event.id);
    }
    if (!verifyEvent(event)) return;
    if (event.pubkey === config.publicKey) return;
    if (event.tags.some((tag) => tag[0] === "encrypted")) {
      rememberRequest(event.id);
      await publishFeedback(
        event,
        "error",
        "Encrypted NIP-90 requests are not supported",
      );
      return;
    }
    const requestedProviders = event.tags
      .filter((tag) => tag[0] === "p")
      .map((tag) => tag[1]);
    if (
      requestedProviders.length > 0 &&
      !requestedProviders.includes(config.publicKey)
    ) {
      return;
    }
    const capability = capabilityFor(event);
    if (!capability) return;
    rememberRequest(event.id);
    if (pendingPayments >= config.maxPendingPayments) {
      await publishFeedback(
        event,
        "error",
        "DVM has reached its pending payment limit; retry with a new request",
      );
      return;
    }
    try {
      await processRequest(event, capability);
    } catch (error) {
      if (!abortController.signal.aborted) {
        const message = error instanceof Error
          ? error.message
          : "Unable to execute DVM job";
        logger.warn({ err: error, eventId: event.id }, "NIP-90 job failed");
        try {
          await publishFeedback(event, "error", message);
        } catch (publishError) {
          logger.warn(
            { err: publishError, eventId: event.id },
            "Unable to publish NIP-90 error feedback",
          );
        }
      }
    }
  };

  function rememberRequest(eventId: string) {
    seen.delete(eventId);
    seen.set(
      eventId,
      now() + config.invoiceExpirySeconds * 1_000 + 5 * 60_000,
    );
    while (seen.size > MAX_SEEN_REQUESTS) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      closeSubscription = transport.subscribe(
        {
          kinds: JOB_REQUEST_KINDS,
          since: Math.floor(now() / 1_000) - 60,
        },
        (event) => {
          const job = handleEvent(event).finally(() => activeJobs.delete(job));
          activeJobs.add(job);
        },
      );
      logger.info(
        {
          relays: config.relays,
          pubkey: config.publicKey,
          kinds: "5000-5990",
        },
        "NIP-90 DVM started",
      );
    },
    async stop() {
      if (!running) return;
      running = false;
      abortController.abort(new Error("NIP-90 DVM stopped"));
      closeSubscription?.();
      transport.close();
      await Promise.allSettled([...activeJobs]);
      logger.info("NIP-90 DVM stopped");
    },
    handleEvent,
  };
}

export async function startNip90Dvm(): Promise<() => Promise<void>> {
  const config = loadDvmConfig();
  const transport = createNostrDvmTransport(config.relays);
  const announcer = createServiceAnnouncer(
    {
      ...config,
      nip05: parseNip05Identifier(
        process.env.NIP05_IDENTIFIER?.trim() ||
          process.env.NOSTR_NIP05?.trim() ||
          undefined,
      )?.identifier,
      picture: process.env.DVM_PICTURE_URL?.trim() || undefined,
      banner: process.env.DVM_BANNER_URL?.trim() || undefined,
    },
    transport,
  );
  let dvm: Nip90Dvm;
  try {
    await announcer.start();
    const { createPostgresRevenueLedger } = await import("./postgres-ledger");
    dvm = createNip90Dvm(config, {
      transport,
      ledger: createPostgresRevenueLedger(),
    });
    dvm.start();
  } catch (error) {
    await announcer.stop();
    transport.close();
    throw error;
  }
  return async () => {
    await announcer.stop();
    await dvm.stop();
  };
}