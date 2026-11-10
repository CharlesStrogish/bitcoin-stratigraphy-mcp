// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash, randomUUID } from "node:crypto";
import type { pool as databasePool } from "@workspace/db";
import type Stripe from "stripe";
import {
  createSubscriptionMacaroon,
  attenuateSubscriptionMacaroon,
} from "../lib/subscription-pass";
import {
  SCANNER_CREDIT_DESCRIPTION,
  SCANNER_CREDIT_SATS,
  SCANNER_CREDIT_SECONDS,
  SCANNER_CREDITS,
} from "../lib/scanner-credits";
import { parseYieldWithdrawalInvoice } from "../lib/yield-withdrawal-invoice";
import type { SettlementProvider } from "./settlement/types";
import type { NwcPayout } from "../lib/nwc-payout";

export type FiatOrderStatus =
  "checkout" | "paid" | "paying" | "ready" | "delivered" | "failed";
type Order = {
  id: string;
  owner_hash: string;
  status: FiatOrderStatus;
  session_id: string | null;
  invoice: string | null;
  payment_hash: string | null;
  macaroon: string | null;
  valid_until: number | null;
  reserved_sats: number;
  created_at: Date;
};
export const fiatOwnerHash = (owner: string) =>
  createHash("sha256").update(owner).digest("hex");

export function validFiatSession(
  session: Stripe.Checkout.Session,
  order: Pick<Order, "id" | "session_id">,
) {
  return (
    !session.livemode &&
    session.id === order.session_id &&
    session.mode === "payment" &&
    session.status === "complete" &&
    session.payment_status === "paid" &&
    session.amount_total === 50_000 &&
    session.currency === "usd" &&
    session.metadata?.fiat_order_id === order.id &&
    session.metadata?.fiat_product === "scanner-100-v1"
  );
}

export class FiatMint {
  constructor(
    private readonly options: {
      pool: typeof databasePool;
      merchant: SettlementProvider;
      payer: NwcPayout;
      stripe: () => Promise<Stripe>;
      priceId: () => string | undefined;
      origin: () => string;
      secret: () => string | undefined;
      allowTreasury: () => boolean;
      budgetSats: () => number;
    },
  ) {}

  async checkout(owner: string): Promise<string> {
    const stripe = await this.options.stripe();
    const priceId = this.options.priceId();
    if (!priceId || !this.options.secret())
      throw new Error("Fiat mint configuration unavailable");
    const price = await stripe.prices.retrieve(priceId);
    if (
      price.livemode ||
      !price.active ||
      price.type !== "one_time" ||
      price.currency !== "usd" ||
      price.unit_amount !== 50_000
    )
      throw new Error("Expected fixed USD 500 test price");
    const hash = fiatOwnerHash(owner);
    await this.options.pool.query(
      "INSERT INTO fiat_mint_orders(id,owner_hash) VALUES($1,$2) ON CONFLICT(owner_hash) DO NOTHING",
      [randomUUID(), hash],
    );
    const {
      rows: [order],
    } = await this.options.pool.query<Order>(
      "SELECT * FROM fiat_mint_orders WHERE owner_hash=$1",
      [hash],
    );
    if (!order || order.status !== "checkout")
      throw new Error("Recover the existing purchase first");
    if (
      !order.session_id &&
      Date.now() - new Date(order.created_at).getTime() > 23 * 3600_000
    )
      throw new Error(
        "Checkout creation outcome needs operator reconciliation",
      );
    // A crash between Stripe creation and our DB update recovers the same session.
    const session = order.session_id
      ? await stripe.checkout.sessions.retrieve(order.session_id)
      : await stripe.checkout.sessions.create(
          {
            mode: "payment",
            allowed_payment_method_types: ["card"],
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${this.options.origin()}/developers?fiat=return`,
            cancel_url: `${this.options.origin()}/developers?fiat=cancelled`,
            metadata: {
              fiat_order_id: order.id,
              fiat_product: "scanner-100-v1",
            },
          },
          { idempotencyKey: `fiat-mint-checkout-${order.id}` },
        );
    if (
      session.livemode ||
      !session.url?.startsWith("https://checkout.stripe.com/")
    )
      throw new Error(
        "Stripe Checkout session is unavailable; recover the original purchase",
      );
    await this.options.pool.query(
      "UPDATE fiat_mint_orders SET session_id=$1 WHERE id=$2 AND session_id IS NULL",
      [session.id, order.id],
    );
    return session.url;
  }

  /** Webhook hints never authorize funding: re-read the exact session from Stripe. */
  async acceptSession(sessionId: string) {
    const stripe = await this.options.stripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const id = session.metadata?.fiat_order_id;
    if (!id) return;
    // A webhook can arrive before the session-creation HTTP response is persisted.
    const {
      rows: [order],
    } = await this.options.pool.query<Order>(
      "SELECT * FROM fiat_mint_orders WHERE id=$1 AND (session_id=$2 OR session_id IS NULL)",
      [id, sessionId],
    );
    if (!order || order.status !== "checkout") return;
    order.session_id ??= sessionId;
    if (!validFiatSession(session, order)) return;
    const items = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 2,
    });
    if (
      items.has_more ||
      items.data.length !== 1 ||
      items.data[0]?.quantity !== 1 ||
      items.data[0]?.price?.id !== this.options.priceId()
    )
      return;
    await this.options.pool.query(
      "UPDATE fiat_mint_orders SET status='paid',session_id=$2 WHERE id=$1 AND status='checkout' AND (session_id=$2 OR session_id IS NULL)",
      [order.id, sessionId],
    );
  }

  async status(owner: string): Promise<FiatOrderStatus | "none"> {
    const {
      rows: [order],
    } = await this.options.pool.query<Order>(
      "SELECT * FROM fiat_mint_orders WHERE owner_hash=$1",
      [fiatOwnerHash(owner)],
    );
    if (order?.status === "checkout" && order.session_id) {
      // Recovery also works when webhook delivery is delayed or the preview is private.
      await this.acceptSession(order.session_id);
      const {
        rows: [updated],
      } = await this.options.pool.query<Order>(
        "SELECT * FROM fiat_mint_orders WHERE id=$1",
        [order.id],
      );
      return updated?.status ?? "none";
    }
    return order?.status ?? "none";
  }

  /** Durable reservation precedes every irreversible wallet operation. No automatic re-pay. */
  async fulfill(id: string) {
    if (
      !this.options.allowTreasury() ||
      !this.options.payer.configured() ||
      !this.options.merchant.isConfigured()
    )
      return;
    const secret = this.options.secret();
    if (!secret) return;
    const client = await this.options.pool.connect();
    let locked = false;
    try {
      locked = (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext('fiat-mint'),hashtext($1)) AS locked",
          [id],
        )
      ).rows[0]!.locked;
      if (!locked) return;
      let order = (
        await client.query<Order>(
          "SELECT * FROM fiat_mint_orders WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!order || !["paid", "paying"].includes(order.status)) return;
      if (order.status === "paid") {
        // Global lifetime cap includes ambiguous and failed attempts. Never release automatically.
        await client.query("BEGIN");
        try {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext('fiat-mint-budget'))",
          );
          const total = Number(
            (
              await client.query<{ total: string }>(
                "SELECT COALESCE(SUM(reserved_sats),0)::text AS total FROM fiat_mint_orders",
              )
            ).rows[0]!.total,
          );
          const budget = this.options.budgetSats();
          if (
            !Number.isSafeInteger(budget) ||
            total + (order.reserved_sats ? 0 : SCANNER_CREDIT_SATS) > budget
          ) {
            await client.query("ROLLBACK");
            return;
          }
          // Repeated pre-invoice crashes retain the existing reservation.
          if (!order.reserved_sats)
            await client.query(
              "UPDATE fiat_mint_orders SET reserved_sats=$1 WHERE id=$2",
              [SCANNER_CREDIT_SATS, id],
            );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        const invoice = await this.options.merchant.createInvoice({
          amountMsats: SCANNER_CREDIT_SATS * 1000,
          description: SCANNER_CREDIT_DESCRIPTION,
          expirySeconds: 900,
          asset: "btc-lightning",
          signal: AbortSignal.timeout(20_000),
        });
        const parsed = parseYieldWithdrawalInvoice(invoice.invoice);
        if (
          parsed.paymentHash !== invoice.paymentHash ||
          parsed.amountMsats !== BigInt(SCANNER_CREDIT_SATS * 1000) ||
          invoice.provider !== "coinos"
        )
          throw new Error("Unexpected merchant invoice");
        const validUntil =
          Math.floor(Date.now() / 1000) + SCANNER_CREDIT_SECONDS;
        const root = createSubscriptionMacaroon({
          secret,
          paymentHash: invoice.paymentHash,
          tier: "1-day",
          validUntil,
          scannerCredits: SCANNER_CREDITS,
          amountMsats: SCANNER_CREDIT_SATS * 1000,
          baseAmountMsats: SCANNER_CREDIT_SATS * 1000,
          paymentAsset: "btc-lightning",
          paymentProvider: "coinos",
        });
        const macaroon = attenuateSubscriptionMacaroon(root, [
          "allowed_path=/api/scanner",
        ]);
        if (!macaroon) throw new Error("Cannot scope scanner macaroon");
        // Commit paying first. After a crash, only lookup is permitted, even if pay was never sent.
        order = (
          await client.query<Order>(
            `UPDATE fiat_mint_orders SET status='paying',invoice=$1,payment_hash=$2,macaroon=$3,valid_until=$4
           WHERE id=$5 RETURNING *`,
            [invoice.invoice, invoice.paymentHash, macaroon, validUntil, id],
          )
        ).rows[0]!;
        const outcome = await this.options.payer.pay(invoice.invoice, parsed);
        if (outcome.status === "failed") {
          await client.query(
            "UPDATE fiat_mint_orders SET status='failed',macaroon=NULL WHERE id=$1",
            [id],
          );
          return;
        }
      }
      if (!order.invoice || !order.payment_hash) return;
      // Parsing with epoch zero allows safe reconciliation after the invoice expires.
      const parsed = parseYieldWithdrawalInvoice(order.invoice, 0);
      const outgoing = await this.options.payer.lookup(parsed);
      if (outgoing.status !== "settled") return;
      const incoming = await this.options.merchant.verifyPayment({
        paymentHash: order.payment_hash,
        preimage: outgoing.preimage ?? "NWC_LOOKUP",
        verificationMode: "merchant-lookup",
        expectedAmountMsats: SCANNER_CREDIT_SATS * 1000,
        expectedDescription: SCANNER_CREDIT_DESCRIPTION,
        expectedProvider: "coinos",
        asset: "btc-lightning",
        signal: AbortSignal.timeout(20_000),
      });
      if (incoming === "invalid" || incoming.provider !== "coinos") return;
      await client.query(
        "UPDATE fiat_mint_orders SET status='ready' WHERE id=$1 AND status='paying'",
        [id],
      );
    } finally {
      try {
        if (locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtext('fiat-mint'),hashtext($1))",
            [id],
          );
        client.release();
      } catch {
        // A broken session must not be returned to the pool holding a financial lock.
        client.release(true);
      }
    }
  }

  async drain() {
    const { rows } = await this.options.pool.query<{ id: string }>(
      "SELECT id FROM fiat_mint_orders WHERE status IN ('paid','paying') ORDER BY (status='paying') DESC,created_at LIMIT 10",
    );
    for (const row of rows) await this.fulfill(row.id);
  }

  async claim(owner: string) {
    // Atomic one-time disclosure. The bearer is never in status, URLs, cookies, or logs.
    const {
      rows: [order],
    } = await this.options.pool.query<Order>(
      `UPDATE fiat_mint_orders SET status='delivered' WHERE owner_hash=$1 AND status='ready'
       AND valid_until > $2 RETURNING *`,
      [fiatOwnerHash(owner), Math.floor(Date.now() / 1000)],
    );
    if (!order?.macaroon) return null;
    return {
      macaroon: order.macaroon,
      credits: SCANNER_CREDITS,
      amount_sats: SCANNER_CREDIT_SATS,
      valid_until: order.valid_until!,
      scope: "/api/scanner" as const,
    };
  }
}
