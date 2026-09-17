export type SubscriptionTier = "1-day" | "30-day";

export type NostrAttestation = {
  protocol: "nostr";
  nip: 78;
  payload_sha256: string;
  event: {
    id: string;
    pubkey: string;
    created_at: number;
    kind: 30078;
    tags: string[][];
    content: string;
    sig: string;
  };
};

export type StratigraphyEntry = {
  day: number;
  title: string;
  video_id: string;
  transcript_summary: string;
  quantitative_alpha: {
    target_multiplier: number;
    difficulty_epoch_progress: string;
    thermodynamic_signal: string;
  };
  attestation?: NostrAttestation;
};

export type StratigraphyTelemetry = {
  observed_at: string;
  block: { height: number | null };
  difficulty: {
    epoch_progress_percent: number;
    estimated_adjustment_percent: number | null;
  };
  market: {
    usd_per_btc: number | null;
    sats_per_usd: number | null;
  };
  thermodynamic: {
    signal: string;
    target_multiplier: number;
  };
  attestation?: NostrAttestation;
};

export type CostDiscovery = {
  protocol: "L402";
  access_tiers: Array<{
    id: SubscriptionTier;
    duration_days: number;
    price_sats: number;
    base_price_sats: number;
    max_price_sats: number;
    multiplier: number;
  }>;
  dynamic_pricing: {
    difficulty_epoch_progress: number;
    request_velocity_rpm: number;
    calculated_at: string;
  };
  legacy_query_pricing: {
    sats_per_day: number;
    minimum_sats: number;
  };
  dataset: {
    days: number;
    first_day: number;
    last_day: number;
    grows_over_time: boolean;
  };
  mcp_tool: {
    name: string;
    parameters: Record<string, unknown>;
  };
  response_schema: Record<string, unknown>;
};

export type L402WalletAdapter = {
  payInvoice(
    invoice: string,
  ): Promise<string | { preimage: string } | { payment_preimage: string }>;
};

export type NwcPaymentClient = {
  payInvoice(input: { invoice: string }): Promise<unknown>;
  close?(): void;
};

export class NwcWalletAdapter implements L402WalletAdapter {
  constructor(private readonly client: NwcPaymentClient) {}

  async payInvoice(invoice: string): Promise<string> {
    const result = await this.client.payInvoice({ invoice });
    return paymentPreimage(result);
  }

  close(): void {
    this.client.close?.();
  }
}

export type CachedL402Credential = {
  macaroon: string;
  preimage: string;
  validUntil: number;
  tier: SubscriptionTier;
};

export type CredentialStore = {
  get(key: string): CachedL402Credential | undefined;
  set(key: string, value: CachedL402Credential): void;
  delete(key: string): void;
};

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, CachedL402Credential>();

  get(key: string): CachedL402Credential | undefined {
    return this.values.get(key);
  }

  set(key: string, value: CachedL402Credential): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

export type StreamSubscription = {
  close(): void;
  readonly closed: boolean;
};

export type BitcoinStratigraphyClientOptions = {
  baseUrl: string;
  wallet: L402WalletAdapter;
  tier?: SubscriptionTier;
  fetch?: typeof globalThis.fetch;
  credentialStore?: CredentialStore;
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

type L402Pass = {
  tier: SubscriptionTier;
  invoice: string;
  payment_hash: string;
  macaroon: string;
  valid_until: number;
  price_sats: number;
};

type L402Challenge = {
  invoice: string;
  payment_hash: string;
  passes: L402Pass[];
};

export class BitcoinStratigraphyClient {
  private readonly baseUrl: string;
  private readonly wallet: L402WalletAdapter;
  private readonly tier: SubscriptionTier;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly credentials: CredentialStore;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private paymentInFlight?: Promise<CachedL402Credential>;

  constructor(options: BitcoinStratigraphyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.wallet = options.wallet;
    this.tier = options.tier ?? "1-day";
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.credentials = options.credentialStore ?? new MemoryCredentialStore();
    this.initialReconnectDelayMs = options.reconnect?.initialDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.reconnect?.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
  }

  async getCost(): Promise<CostDiscovery> {
    return this.fetchJson<CostDiscovery>("/api/v1/cost");
  }

  async getLatest(): Promise<StratigraphyEntry[]> {
    await this.getCost();
    return this.authorizedJson<StratigraphyEntry[]>("/api/v1/stratigraphy");
  }

  subscribeStream(
    onTelemetry: (telemetry: StratigraphyTelemetry) => void,
    onError: (error: unknown) => void = () => undefined,
  ): StreamSubscription {
    const controller = new AbortController();
    let closed = false;

    const run = async () => {
      let reconnectDelay = this.initialReconnectDelayMs;
      while (!controller.signal.aborted) {
        try {
          const response = await this.authorizedResponse(
            "/api/v1/stratigraphy/stream",
            controller.signal,
          );
          reconnectDelay = this.initialReconnectDelayMs;
          await consumeSse(response, onTelemetry, controller.signal);
          if (!controller.signal.aborted) {
            throw new Error("Bitcoin Stratigraphy stream closed");
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          onError(error);
          try {
            await this.sleep(reconnectDelay, controller.signal);
          } catch {
            break;
          }
          reconnectDelay = Math.min(
            reconnectDelay * 2,
            this.maxReconnectDelayMs,
          );
        }
      }
    };
    void run();

    return {
      close() {
        if (closed) return;
        closed = true;
        controller.abort();
      },
      get closed() {
        return closed;
      },
    };
  }

  private credentialKey(): string {
    return `${this.baseUrl}:${this.tier}`;
  }

  private currentCredential(): CachedL402Credential | undefined {
    const key = this.credentialKey();
    const credential = this.credentials.get(key);
    if (!credential) return undefined;
    if (credential.validUntil <= Math.floor(this.now() / 1_000)) {
      this.credentials.delete(key);
      return undefined;
    }
    return credential;
  }

  private authorization(credential: CachedL402Credential): string {
    return `L402 ${credential.macaroon}:${credential.preimage}`;
  }

  private async authorizedJson<T>(path: string): Promise<T> {
    const response = await this.authorizedResponse(path);
    return parseJson<T>(response);
  }

  private async authorizedResponse(
    path: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let credential = this.currentCredential();
    let sentAuthorization = credential
      ? this.authorization(credential)
      : undefined;
    let response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: sentAuthorization
        ? { Authorization: sentAuthorization }
        : undefined,
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      const current = this.currentCredential();
      if (
        !current ||
        this.authorization(current) === sentAuthorization
      ) {
        this.credentials.delete(this.credentialKey());
      }
      credential = undefined;
    }
    if (response.status !== 402 && response.ok) return response;
    if (response.status !== 402) throw await httpError(response);

    const newerCredential = this.currentCredential();
    if (
      newerCredential &&
      this.authorization(newerCredential) !== sentAuthorization
    ) {
      credential = newerCredential;
      sentAuthorization = this.authorization(credential);
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        headers: { Authorization: sentAuthorization },
        signal,
      });
      if (response.ok) return response;
      if (response.status !== 402) throw await httpError(response);
    }

    const challenge = await parseJson<L402Challenge>(response);
    credential = await this.payChallenge(challenge);
    response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: { Authorization: this.authorization(credential) },
      signal,
    });
    if (!response.ok) throw await httpError(response);
    return response;
  }

  private payChallenge(
    challenge: L402Challenge,
  ): Promise<CachedL402Credential> {
    if (this.paymentInFlight) return this.paymentInFlight;
    const selected = challenge.passes.find((pass) => pass.tier === this.tier);
    if (
      !selected ||
      typeof selected.invoice !== "string" ||
      typeof selected.macaroon !== "string" ||
      typeof selected.valid_until !== "number" ||
      !/^[0-9a-fA-F]{64}$/.test(selected.payment_hash)
    ) {
      throw new Error(`L402 challenge did not include tier ${this.tier}`);
    }
    this.paymentInFlight = this.wallet
      .payInvoice(selected.invoice)
      .then(async (result) => {
        const preimage = paymentPreimage(result);
        const paymentHash = await sha256Hex(preimage);
        if (paymentHash !== selected.payment_hash.toLowerCase()) {
          throw new Error(
            "Wallet preimage does not match the L402 payment hash",
          );
        }
        const credential = {
          macaroon: selected.macaroon,
          preimage,
          validUntil: selected.valid_until,
          tier: selected.tier,
        };
        this.credentials.set(this.credentialKey(), credential);
        return credential;
      })
      .finally(() => {
        this.paymentInFlight = undefined;
      });
    return this.paymentInFlight;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`);
    if (!response.ok) throw await httpError(response);
    return parseJson<T>(response);
  }
}

function paymentPreimage(value: unknown): string {
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? ("preimage" in value
            ? value.preimage
            : "payment_preimage" in value
              ? value.payment_preimage
              : undefined)
        : undefined;
  if (typeof candidate !== "string" || !/^[0-9a-fA-F]{64}$/.test(candidate)) {
    throw new Error("Wallet did not return a 32-byte payment preimage");
  }
  return candidate.toLowerCase();
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(`Invalid JSON response from ${response.url || "server"}`, {
      cause: error,
    });
  }
}

async function httpError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(
    `Bitcoin Stratigraphy request failed (${response.status})${body ? `: ${body}` : ""}`,
  );
}

async function consumeSse(
  response: Response,
  onTelemetry: (telemetry: StratigraphyTelemetry) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("SSE response did not include a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = "";
  let buffer = "";
  const appendChunk = (chunk: string, flush = false) => {
    rawBuffer += chunk;
    const keepTrailingCarriageReturn = !flush && rawBuffer.endsWith("\r");
    const processable = keepTrailingCarriageReturn
      ? rawBuffer.slice(0, -1)
      : rawBuffer;
    rawBuffer = keepTrailingCarriageReturn ? "\r" : "";
    buffer += processable.replace(/\r\n|\r/g, "\n");
  };
  const dispatchFrames = () => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseFrame(frame);
      if (event.type === "telemetry" && event.data) {
        onTelemetry(JSON.parse(event.data) as StratigraphyTelemetry);
      }
      boundary = buffer.indexOf("\n\n");
    }
  };
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      appendChunk(decoder.decode(value, { stream: true }));
      dispatchFrames();
    }
    appendChunk(decoder.decode(), true);
    dispatchFrames();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSseFrame(frame: string): { type: string; data: string } {
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { type, data: data.join("\n") };
}

function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function sha256Hex(hexValue: string): Promise<string> {
  const bytes = Uint8Array.from(
    hexValue.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}