import { createHash } from "node:crypto";
import {
  createDefaultSettlementRouter,
  createSettlementRouter,
  type NwcClientFactory,
  type SettlementRouter,
} from "./settlement";
import {
  SETTLEMENT_ASSETS,
  SettlementProviderError,
  type SettlementAsset,
  type SettlementInvoice,
  type SettlementInvoiceInput,
  type SettlementProvider,
  type SettlementVerification,
  type SettlementVerificationInput,
} from "./settlement/types";

export interface MultiSettlementRouter extends SettlementRouter {
  supportedAssets(): readonly SettlementAsset[];
  availableAssets(): readonly SettlementAsset[];
  isConfigured(asset?: SettlementAsset): boolean;
  activeProvider(asset?: SettlementAsset): string;
}

type HandlerResponse = {
  invoice?: unknown;
  payment_hash?: unknown;
  status?: unknown;
  settled_at?: unknown;
  asset?: unknown;
  amount_msats?: unknown;
  description?: unknown;
};

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function parseSettledAt(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value);
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

export function createHttpAssetSettlementProvider(input: {
  name: string;
  asset: Exclude<SettlementAsset, "btc-lightning">;
  baseUrl?: string;
  authorization?: string;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
}): SettlementProvider {
  const fetcher = input.fetch ?? globalThis.fetch;
  const baseUrl = (() => {
    if (!input.baseUrl) return undefined;
    try {
      const url = new URL(input.baseUrl);
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
      ) {
        return undefined;
      }
      return url.toString().replace(/\/+$/, "");
    } catch {
      return undefined;
    }
  })();
  const pollIntervalMs = input.pollIntervalMs ?? 250;

  const request = async (
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HandlerResponse> => {
    if (!baseUrl) {
      throw new SettlementProviderError(
        `${input.name} settlement handler is not configured`,
        false,
      );
    }
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(input.authorization
            ? { Authorization: `Bearer ${input.authorization}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new SettlementProviderError(
        `${input.name} settlement handler request failed`,
        true,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new SettlementProviderError(
        `${input.name} settlement handler returned HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    try {
      return (await response.json()) as HandlerResponse;
    } catch (error) {
      throw new SettlementProviderError(
        `${input.name} settlement handler returned invalid JSON`,
        false,
        { cause: error },
      );
    }
  };

  return {
    name: input.name,
    isConfigured: () => Boolean(baseUrl),
    async createInvoice(requestInput): Promise<SettlementInvoice> {
      const result = await request(
        "/invoices",
        {
          asset: input.asset,
          amount_msats: requestInput.amountMsats,
          description: requestInput.description,
          expiry_seconds: requestInput.expirySeconds,
        },
        requestInput.signal,
      );
      if (
        typeof result.invoice !== "string" ||
        !result.invoice ||
        typeof result.payment_hash !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(result.payment_hash)
      ) {
        throw new SettlementProviderError(
          `${input.name} settlement handler returned an invalid invoice`,
          false,
        );
      }
      return {
        invoice: result.invoice,
        paymentHash: result.payment_hash.toLowerCase(),
        provider: input.name,
        asset: input.asset,
      };
    },
    async verifyPayment(
      verificationInput,
    ): Promise<Exclude<SettlementVerification, "unavailable">> {
      if (
        !/^[0-9a-fA-F]{64}$/.test(verificationInput.preimage) ||
        createHash("sha256")
          .update(Buffer.from(verificationInput.preimage, "hex"))
          .digest("hex") !== verificationInput.paymentHash.toLowerCase()
      ) {
        return "invalid";
      }
      while (!verificationInput.signal?.aborted) {
        const result = await request(
          "/payments/verify",
          {
            asset: input.asset,
            payment_hash: verificationInput.paymentHash,
            proof: verificationInput.preimage,
            expected_amount_msats: verificationInput.expectedAmountMsats,
            expected_description: verificationInput.expectedDescription,
          },
          verificationInput.signal,
        );
        if (result.status === "invalid" || result.status === "failed") {
          return "invalid";
        }
        if (result.status === "settled") {
          const settledAt = parseSettledAt(result.settled_at);
          const receiptMatches =
            result.payment_hash === verificationInput.paymentHash &&
            result.asset === input.asset &&
            result.amount_msats === verificationInput.expectedAmountMsats &&
            result.description === verificationInput.expectedDescription &&
            settledAt !== null &&
            settledAt <= Math.floor(Date.now() / 1_000) + 60;
          return receiptMatches
            ? { settledAt, provider: input.name, asset: input.asset }
            : "invalid";
        }
        if (result.status !== "pending") {
          throw new SettlementProviderError(
            `${input.name} settlement handler returned an invalid payment status`,
            false,
          );
        }
        await abortableDelay(pollIntervalMs, verificationInput.signal);
      }
      throw verificationInput.signal?.reason;
    },
  };
}

function unavailableProvider(
  name: string,
  asset: Exclude<SettlementAsset, "btc-lightning">,
): SettlementProvider {
  return createHttpAssetSettlementProvider({ name, asset });
}

export function createMultiSettlementRouter(input: {
  lightning: SettlementRouter;
  liquid: SettlementRouter;
  taprootAssets: SettlementRouter;
}): MultiSettlementRouter {
  const routers: Record<SettlementAsset, SettlementRouter> = {
    "btc-lightning": input.lightning,
    "l-btc": input.liquid,
    "taproot-assets": input.taprootAssets,
  };
  const selected = (asset: SettlementAsset = "btc-lightning") => routers[asset];

  return {
    supportedAssets: () => SETTLEMENT_ASSETS,
    availableAssets: () =>
      SETTLEMENT_ASSETS.filter((asset) => selected(asset).isConfigured()),
    isConfigured: (asset) =>
      asset
        ? selected(asset).isConfigured()
        : Object.values(routers).some((router) => router.isConfigured()),
    activeProvider: (asset = "btc-lightning") =>
      selected(asset).activeProvider(),
    circuitState: () => selected().circuitState(),
    async createInvoice(requestInput) {
      const asset = requestInput.asset ?? "btc-lightning";
      if (!selected(asset).isConfigured()) {
        throw new SettlementProviderError(
          `${asset} settlement is not configured`,
          false,
        );
      }
      const invoice = await selected(asset).createInvoice(requestInput);
      return { ...invoice, asset };
    },
    async verifyPayment(verificationInput) {
      const asset = verificationInput.asset ?? "btc-lightning";
      if (!selected(asset).isConfigured()) return "unavailable";
      return selected(asset).verifyPayment(verificationInput);
    },
  };
}

export function createDefaultMultiSettlementRouter(
  clientFactory?: NwcClientFactory,
): MultiSettlementRouter {
  const liquidPrimary = createHttpAssetSettlementProvider({
    name: "liquid",
    asset: "l-btc",
    baseUrl: process.env.LIQUID_SETTLEMENT_URL,
    authorization: process.env.LIQUID_SETTLEMENT_TOKEN,
  });
  const liquidFallback = process.env.LIQUID_SETTLEMENT_FALLBACK_URL
    ? createHttpAssetSettlementProvider({
        name: "liquid-fallback",
        asset: "l-btc",
        baseUrl: process.env.LIQUID_SETTLEMENT_FALLBACK_URL,
        authorization: process.env.LIQUID_SETTLEMENT_FALLBACK_TOKEN,
      })
    : unavailableProvider("liquid-fallback", "l-btc");
  const taprootPrimary = createHttpAssetSettlementProvider({
    name: "taproot-assets",
    asset: "taproot-assets",
    baseUrl: process.env.TAPROOT_ASSETS_SETTLEMENT_URL,
    authorization: process.env.TAPROOT_ASSETS_SETTLEMENT_TOKEN,
  });
  const taprootFallback = process.env.TAPROOT_ASSETS_SETTLEMENT_FALLBACK_URL
    ? createHttpAssetSettlementProvider({
        name: "taproot-assets-fallback",
        asset: "taproot-assets",
        baseUrl: process.env.TAPROOT_ASSETS_SETTLEMENT_FALLBACK_URL,
        authorization: process.env.TAPROOT_ASSETS_SETTLEMENT_FALLBACK_TOKEN,
      })
    : unavailableProvider("taproot-assets-fallback", "taproot-assets");

  return createMultiSettlementRouter({
    lightning: createDefaultSettlementRouter(clientFactory),
    liquid: createSettlementRouter({
      primary: liquidPrimary,
      fallback: liquidFallback,
    }),
    taprootAssets: createSettlementRouter({
      primary: taprootPrimary,
      fallback: taprootFallback,
    }),
  });
}

export function isSettlementAsset(value: unknown): value is SettlementAsset {
  return (
    typeof value === "string" &&
    (SETTLEMENT_ASSETS as readonly string[]).includes(value)
  );
}

export type {
  SettlementAsset,
  SettlementInvoiceInput,
  SettlementVerificationInput,
};