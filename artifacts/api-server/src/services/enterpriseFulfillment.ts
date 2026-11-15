// Copyright (c) 2026 Charles R. Strogish. AGPL-3.0-only / Commercial.
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type Stripe from "stripe";
import { validFiatSession, type FiatMint } from "./fiatMint";
import type { EnterpriseMailer } from "./enterpriseEmail";

export const ENTERPRISE_PAYMENT_LINK =
  "https://buy.stripe.com/8x228q0IE9A40uHehz7ss00";

type Delivery = {
  session_id: string;
  order_id: string;
  recipient: string;
  state: string;
};
type Order = {
  id: string;
  session_id: string | null;
  status: string;
  macaroon: string | null;
  valid_until: number | null;
};

/** Coordinates existing funded minting; does not alter macaroons or payment rules. */
export class EnterpriseFulfillment {
  constructor(
    private readonly options: {
      pool: Pool;
      mint: Pick<FiatMint, "acceptSession" | "fulfill">;
      priceId: () => string | undefined;
      mailer: () => EnterpriseMailer;
    },
  ) {}

  async fulfill(
    sessionId: string,
    eventId: string,
    runtime: { stripe: Stripe; livemode: boolean },
  ): Promise<void> {
    const { stripe, livemode } = runtime;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (
      session.id !== sessionId ||
      session.livemode !== livemode ||
      session.mode !== "payment" ||
      session.status !== "complete" ||
      session.payment_status !== "paid" ||
      session.amount_total !== 50_000 ||
      session.currency !== "usd"
    )
      return;
    const managed =
      session.metadata?.fiat_product === "scanner-100-v1" &&
      Boolean(session.metadata.fiat_order_id);
    if (!managed) {
      const linkId =
        typeof session.payment_link === "string"
          ? session.payment_link
          : session.payment_link?.id;
      if (!linkId) return; // Other $500 products do not acquire this entitlement.
      const link = await stripe.paymentLinks.retrieve(linkId);
      if (link.url !== ENTERPRISE_PAYMENT_LINK || link.livemode !== livemode)
        return;
    }
    const priceId = this.options.priceId();
    if (!priceId) throw new Error("Enterprise price configuration unavailable");
    const items = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 2,
    });
    const item = items.data[0];
    if (
      items.has_more ||
      items.data.length !== 1 ||
      item?.quantity !== 1 ||
      item.price?.id !== priceId ||
      item.price.livemode !== livemode ||
      item.price.currency !== "usd" ||
      item.price.unit_amount !== 50_000 ||
      item.price.type !== "one_time"
    )
      return;
    const recipient = session.customer_details?.email ?? session.customer_email;
    if (
      !recipient ||
      recipient.length > 254 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient)
    )
      throw new Error("Checkout customer email unavailable");
    // Validate email configuration before any funding side effects.
    const sendEmail = this.options.mailer();
    const client = await this.options.pool.connect();
    let locked = false;
    try {
      locked = (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext('enterprise-email'),hashtext($1)) AS locked",
          [sessionId],
        )
      ).rows[0]!.locked;
      if (!locked) throw new Error("Enterprise fulfillment busy");
      let delivery = (
        await client.query<Delivery>(
          "SELECT * FROM stripe_enterprise_deliveries WHERE session_id=$1",
          [sessionId],
        )
      ).rows[0];
      if (delivery?.state === "sent") return;
      if (delivery && delivery.state !== "pending")
        throw new Error("Email delivery requires operator reconciliation");
      if (delivery && delivery.recipient !== recipient)
        throw new Error("Checkout recipient changed; reconciliation required");

      if (!delivery) {
        let orderId: string;
        if (managed) {
          orderId = session.metadata!.fiat_order_id!;
          const order = (
            await client.query<Order>(
              "SELECT * FROM fiat_mint_orders WHERE id=$1",
              [orderId],
            )
          ).rows[0];
          if (
            !order ||
            (order.session_id !== null && order.session_id !== sessionId)
          )
            throw new Error("Checkout order ownership mismatch");
          if (
            !validFiatSession(
              session,
              { id: orderId, session_id: sessionId },
              livemode,
            )
          )
            throw new Error("Checkout order mismatch");
        } else {
          if (session.metadata?.fiat_order_id || session.metadata?.fiat_product)
            throw new Error("Unexpected Payment Link fulfillment metadata");
          orderId = randomUUID();
        }
        await client.query("BEGIN");
        try {
          if (!managed) {
            const ownerHash = createHash("sha256")
              .update(`enterprise-payment-link:${sessionId}`)
              .digest("hex");
            await client.query(
              "INSERT INTO fiat_mint_orders(id,owner_hash,session_id) VALUES($1,$2,$3)",
              [orderId, ownerHash, sessionId],
            );
          }
          delivery = (
            await client.query<Delivery>(
              `INSERT INTO stripe_enterprise_deliveries(session_id,order_id,recipient,event_id)
             VALUES($1,$2,$3,$4) RETURNING *`,
              [sessionId, orderId, recipient, eventId],
            )
          ).rows[0]!;
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      // Payment Link sessions need only metadata annotations so the UNCHANGED
      // existing mint can re-read and validate its normal order binding.
      if (!managed) {
        await stripe.checkout.sessions.update(
          sessionId,
          {
            metadata: {
              ...session.metadata,
              fiat_order_id: delivery.order_id,
              fiat_product: "scanner-100-v1",
            },
          },
          { idempotencyKey: `enterprise-bind-${sessionId}` },
        );
      } else if (session.metadata!.fiat_order_id !== delivery.order_id) {
        throw new Error("Persisted order mismatch");
      }
      await this.options.mint.acceptSession(sessionId);
      await this.options.mint.fulfill(delivery.order_id);
      const order = (
        await client.query<Order>(
          "SELECT * FROM fiat_mint_orders WHERE id=$1",
          [delivery.order_id],
        )
      ).rows[0];
      if (
        !order ||
        order.session_id !== sessionId ||
        !["ready", "delivered"].includes(order.status) ||
        !order.macaroon ||
        !order.valid_until ||
        order.valid_until <= Math.floor(Date.now() / 1000)
      )
        throw new Error("Funded credential not ready; retry the same purchase");
      // Persist before external I/O. A crash/timeout/unknown outcome never
      // automatically resends a secret or mints a replacement credential.
      await client.query(
        "UPDATE stripe_enterprise_deliveries SET state='sending',send_started_at=now() WHERE session_id=$1",
        [sessionId],
      );
      const messageId = await sendEmail(
        recipient,
        order.macaroon,
        `enterprise-${sessionId}`,
      );
      await client.query(
        `UPDATE stripe_enterprise_deliveries SET state='sent',message_id=$2,delivered_at=now()
         WHERE session_id=$1 AND state='sending'`,
        [sessionId, messageId],
      );
    } finally {
      try {
        if (locked)
          await client.query(
            "SELECT pg_advisory_unlock(hashtext('enterprise-email'),hashtext($1))",
            [sessionId],
          );
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
}
