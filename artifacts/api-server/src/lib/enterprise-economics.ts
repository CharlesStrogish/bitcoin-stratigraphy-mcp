// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  canonical,
  loadArticle12IssuerKey,
  signIssuerPayload,
} from "./article12-signature";
import type { KeyObject } from "node:crypto";
import type {
  EnterpriseAccount,
  EnterpriseEconomicsStore,
  RoutingInvoice,
} from "./enterprise-economics-store";
import type { SettlementRouter } from "../services/settlement";

export const EXEMPTION_SECONDS = 365 * 24 * 60 * 60;
export const EXEMPTION_USD_CENTS = 25_000_000;
type PriceReader = () => Promise<number | null>;
export type EnterpriseContext = {
  buyer?: string;
  payout?: string;
  parentPayout?: string;
  account?: EnterpriseAccount;
  invoices: Map<string, RoutingInvoice>;
  onSettlement?: () => void;
  now?: () => number;
};
export const enterpriseContext = new AsyncLocalStorage<EnterpriseContext>();
let configuredService: EnterpriseEconomics | undefined;
export function configureEnterpriseEconomics(
  service: EnterpriseEconomics,
): void {
  configuredService = service;
}

/** A bounded current-market quote, never a fabricated or indefinitely stale price. */
export function createLiveBtcPriceReader(): PriceReader {
  let cached: { cents: number; at: number } | undefined;
  let pending: Promise<number | null> | undefined;
  return async () => {
    if (process.env.BITCOIN_CORE_RPC_URL) return null; // Local/air-gap mode must not silently phone home for FX.
    if (cached && Date.now() - cached.at < 60_000) return cached.cents;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch(
          "https://api.coinbase.com/v2/prices/BTC-USD/spot",
          {
            signal: AbortSignal.timeout(4_000),
          },
        );
        if (!response.ok) return null;
        const body = (await response.json()) as {
          data?: { amount?: string; base?: string; currency?: string };
        };
        if (
          body.data?.base !== "BTC" ||
          body.data.currency !== "USD" ||
          !/^\d+(?:\.\d+)?$/.test(body.data.amount ?? "")
        )
          return null;
        const cents = Math.floor(Number(body.data.amount) * 100);
        if (!Number.isSafeInteger(cents) || cents <= 0) return null;
        cached = { cents, at: Date.now() };
        return cents;
      } catch {
        return null;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}

export class EnterpriseEconomics {
  constructor(
    readonly store: EnterpriseEconomicsStore,
    readonly readPrice: PriceReader = createLiveBtcPriceReader(),
    readonly loadKey: () => KeyObject = loadArticle12IssuerKey,
    readonly now: () => number = Date.now,
  ) {}

  private reconcile(account: EnterpriseAccount, price: number | null): void {
    const seconds = Math.floor(this.now() / 1_000);
    if (account.grant && account.grant.exp > seconds) return;
    if (!price || !Number.isSafeInteger(price) || price <= 0) return;
    if (
      BigInt(account.qualifying_msats) * BigInt(price) <
      BigInt(EXEMPTION_USD_CENTS) * 100_000_000_000n
    )
      return;
    account.grant = {
      iat: seconds,
      exp: seconds + EXEMPTION_SECONDS,
      threshold_price_usd_cents: price,
    };
    // Each annual grant consumes its qualifying volume once. Historical spend
    // cannot renew another year; new settled purchases accrue in the next cycle.
    account.qualifying_msats = "0";
  }

  async status(buyer: string): Promise<EnterpriseAccount> {
    const price = await this.readPrice();
    return this.store.transaction("buyer:" + buyer, async (tx) => {
      const account = await tx.account(buyer);
      this.reconcile(account, price);
      await tx.putAccount(account);
      return account;
    });
  }

  token(account?: EnterpriseAccount): Record<string, unknown> | undefined {
    if (!account?.grant || account.grant.exp <= Math.floor(this.now() / 1_000))
      return undefined;
    return signIssuerPayload(
      {
        receipt_type: "tier_ii_commercial_enterprise_exemption",
        sub: account.buyer,
        license: "Tier II Commercial Enterprise Exemption",
        iat: account.grant.iat,
        exp: account.grant.exp,
        unlock_date: new Date(account.grant.iat * 1_000).toISOString(),
        expiry_date: new Date(account.grant.exp * 1_000).toISOString(),
        threshold_usd: 250_000,
        threshold_price_usd_cents: account.grant.threshold_price_usd_cents,
        renewal:
          "New qualifying confirmed spend required; no reuse of consumed historical spend",
      },
      this.loadKey(),
      "commercial-exemption-ed25519-v1",
      "bitcoin-stratigraphy/commercial-exemption/v1\n",
    );
  }

  describe(context: EnterpriseContext): Record<string, unknown> {
    const token = this.token(context.account);
    return {
      routing_kickback_percent: context.payout ? 21 : 0,
      direct_kickback_percent: context.payout
        ? context.parentPayout
          ? 14
          : 21
        : 0,
      parent_kickback_percent: context.parentPayout ? 7 : 0,
      reward_policy: "21-cap-v1",
      reward_release_requires:
        "verified_invoice_and_provider_bound_address_signature",
      payout_address: context.payout ?? null,
      parent_payout_address: context.parentPayout ?? null,
      payout_mode: "ledger_only_no_automatic_disbursement",
      buyer_pubkey: context.buyer ?? null,
      cumulative_spend_msats: context.account?.total_msats ?? "0",
      cumulative_spend_sats: context.account
        ? (BigInt(context.account.total_msats) / 1_000n).toString()
        : "0",
      qualifying_spend_msats: context.account?.qualifying_msats ?? "0",
      commercial_exemption_status: token
        ? "Active"
        : context.account?.grant
          ? "Expired"
          : "Inactive",
      licensing_status: token
        ? "Tier II Commercial Enterprise Exemption"
        : "AGPLv3 viral copyleft — no active commercial exemption",
      copyleft_risk: token ? "commercially_exempt" : "high",
      legal_scope: "Actual AGPL obligations depend on covered software and use",
      ...(token ? { commercial_exemption_token: token } : {}),
    };
  }

  async issue(
    invoice: { paymentHash: string; provider: string },
    amount: number,
    context: EnterpriseContext,
  ): Promise<RoutingInvoice> {
    if (
      context.parentPayout &&
      (!context.payout || context.parentPayout === context.payout)
    )
      throw new Error("Parent payout requires a distinct direct payout");
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      !/^[0-9a-f]{64}$/.test(invoice.paymentHash)
    ) {
      throw new Error("Invalid enterprise invoice");
    }
    const kickback = context.payout
      ? ((BigInt(amount) * 21n) / 100n).toString()
      : "0";
    // Floor each independently to the millisatoshi. Never assign rounding dust
    // to an agent, and never exceed the 21% total allocation.
    const directKickback = context.parentPayout
      ? ((BigInt(amount) * 14n) / 100n).toString()
      : kickback;
    const parentKickback = context.parentPayout
      ? ((BigInt(amount) * 7n) / 100n).toString()
      : "0";
    const totalKickback = (
      BigInt(directKickback) + BigInt(parentKickback)
    ).toString();
    const allocation = signIssuerPayload(
      {
        receipt_type: "autonomous_routing_kickback",
        label: "Autonomous Routing Kickback",
        payment_hash: invoice.paymentHash,
        payment_provider: invoice.provider,
        payment_asset: "btc-lightning",
        invoice_amount_msats: String(amount),
        kickback_msats: totalKickback,
        reward_policy: "21-cap-v1",
        reward_release_requires:
          "verified_invoice_and_provider_bound_address_signature",
        ...(context.parentPayout
          ? {
              allocation_version: 3,
              direct_kickback_percent: 14,
              parent_kickback_percent: 7,
              direct_kickback_msats: directKickback,
              parent_kickback_msats: parentKickback,
              parent_payout_address: context.parentPayout,
              payout_mode: "ledger_only_no_automatic_disbursement",
            }
          : {}),
        payout_address: context.payout ?? null,
        buyer_pubkey: context.buyer ?? null,
        issued_at: new Date(this.now()).toISOString(),
        payable_only_after_verified_settlement: true,
        payable_only_after_verified_address: true,
        initial_reward_state: "pending",
      },
      this.loadKey(),
      "routing-kickback-ed25519-v1",
      "bitcoin-stratigraphy/routing-kickback/v1\n",
    );
    const record: RoutingInvoice = {
      hash: invoice.paymentHash,
      provider: invoice.provider,
      amount_msats: String(amount),
      buyer: context.buyer,
      payout: context.payout,
      kickback_msats: totalKickback,
      ...(context.parentPayout
        ? {
            parent_payout: context.parentPayout,
            direct_kickback_msats: directKickback,
            parent_kickback_msats: parentKickback,
          }
        : {}),
      allocation,
    };
    const bound = await this.store.transaction(
      "invoice:" + record.hash,
      async (tx) => {
        const old = await tx.invoice(record.hash);
        const binding = (value: RoutingInvoice) => [
          value.hash,
          value.provider,
          value.amount_msats,
          value.buyer ?? null,
          value.payout ?? null,
          value.parent_payout ?? null,
        ];
        if (old && canonical(binding(old)) !== canonical(binding(record))) {
          throw new Error("Invoice economics already bound");
        }
        if (!old) await tx.putInvoice(record);
        return old ?? record;
      },
    );
    context.invoices.set(bound.hash, bound);
    return bound;
  }

  async settle(
    hash: string,
    amount: number,
    provider: string,
  ): Promise<EnterpriseAccount | undefined> {
    return this.store.transaction("invoice:" + hash, async (tx) => {
      const invoice = await tx.invoice(hash);
      if (!invoice) return undefined; // Historical invoices predate this accounting layer.
      if (
        invoice.amount_msats !== String(amount) ||
        invoice.provider !== provider
      ) {
        throw new Error("Settlement does not match registered invoice");
      }
      const account = invoice.buyer
        ? await tx.account(invoice.buyer)
        : undefined;
      if (!invoice.settled_at) {
        invoice.settled_at = new Date(this.now()).toISOString();
        if (account) {
          account.total_msats = (
            BigInt(account.total_msats) + BigInt(invoice.amount_msats)
          ).toString();
          account.qualifying_msats = (
            BigInt(account.qualifying_msats) + BigInt(invoice.amount_msats)
          ).toString();
        }
        await tx.putInvoice(invoice);
      }
      if (account) {
        this.reconcile(account, await this.readPrice());
        await tx.putAccount(account);
      }
      return account;
    });
  }

  wrap(router: SettlementRouter): SettlementRouter {
    return {
      isConfigured: (asset) => router.isConfigured(asset),
      activeProvider: (asset) => router.activeProvider(asset),
      circuitState: () => router.circuitState(),
      createInvoice: async (request) => {
        const invoice = await router.createInvoice(request);
        const context = enterpriseContext.getStore();
        if (
          context &&
          (context.buyer || context.payout) &&
          (request.asset ?? "btc-lightning") === "btc-lightning"
        ) {
          if (invoice.asset && invoice.asset !== "btc-lightning")
            throw new Error("Invoice asset mismatch");
          await this.issue(invoice, request.amountMsats, context);
        }
        return invoice;
      },
      verifyPayment: async (request) => {
        const result = await router.verifyPayment(request);
        if (
          typeof result === "object" &&
          (request.asset ?? "btc-lightning") === "btc-lightning" &&
          (!result.asset || result.asset === "btc-lightning")
        ) {
          const account = await this.settle(
            request.paymentHash,
            request.expectedAmountMsats,
            result.provider,
          );
          const context = enterpriseContext.getStore();
          if (context && account?.buyer === context.buyer)
            context.account = account;
          context?.onSettlement?.();
        }
        return result;
      },
    };
  }
}

export function decorateEnterpriseSettlementRouter(
  router: SettlementRouter,
): SettlementRouter {
  return configuredService ? configuredService.wrap(router) : router;
}

/** Issuer-only, HMAC-covered root metadata; never accepted as holder attenuation. */
export function enterpriseMacaroonFields(paymentHash: string): {
  caveats: string[];
  expires?: number;
} {
  const context = enterpriseContext.getStore();
  if (!context) return { caveats: [] };
  const invoice = context.invoices.get(paymentHash);
  const active =
    context.account?.grant &&
    context.account.grant.exp > Math.floor((context.now ?? Date.now)() / 1_000);
  return {
    caveats: [
      ...(context.buyer ? [`enterprise_buyer=${context.buyer}`] : []),
      ...(invoice?.payout
        ? [
            `routing_kickback=${Buffer.from(JSON.stringify(invoice.allocation)).toString("base64url")}`,
          ]
        : []),
      ...(active
        ? [
            "Commercial-Exemption: Active",
            `commercial_exemption_exp=${context.account!.grant!.exp}`,
          ]
        : []),
    ],
    ...(active ? { expires: context.account!.grant!.exp } : {}),
  };
}

export function enterpriseChallengeScope(): string {
  const context = enterpriseContext.getStore();
  const grant = context?.account?.grant;
  const activeGrant =
    grant && grant.exp > Math.floor((context?.now ?? Date.now)() / 1_000)
      ? grant.iat
      : null;
  return context && (context.buyer || context.payout)
    ? ":economics:" +
        createHash("sha256")
          .update(
            JSON.stringify(
              context.parentPayout
                ? [
                    context.buyer,
                    context.payout,
                    activeGrant,
                    context.parentPayout,
                  ]
                : [context.buyer, context.payout, activeGrant],
            ),
          )
          .digest("hex") +
        ":21-cap-v1"
    : "";
}

export async function bindEnterpriseInvoiceToContext(
  hash: string,
): Promise<void> {
  const context = enterpriseContext.getStore();
  if (!context || !configuredService || (!context.buyer && !context.payout))
    return;
  const invoice = await configuredService.store.transaction(
    "invoice:" + hash,
    (tx) => tx.invoice(hash),
  );
  if (!invoice) return;
  if (
    invoice.buyer !== context.buyer ||
    invoice.payout !== context.payout ||
    invoice.parent_payout !== context.parentPayout
  )
    throw new Error("Invoice attribution mismatch");
  context.invoices.set(hash, invoice);
}
