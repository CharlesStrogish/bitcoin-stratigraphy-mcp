import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import {
  requestNip98Authorization,
  verifyRequestNip98Signer,
} from "./nip98-request";
import { declaredAgentId } from "./agent-id-caveat";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  inspectSubscriptionMacaroon,
} from "./subscription-pass";
import { enterpriseContext } from "./enterprise-economics";
import { parseL402Header, paymentVerificationProof } from "../middleware/l402";
import type { SettlementRouter } from "../services/settlement";
import { recordRevenueWithRetry, type RevenueLedger } from "../services/ledger";
import { randomUUID } from "node:crypto";
import {
  createPostgresEnterpriseCreditStore,
  newCreditState,
  type CreditAccount,
  type CreditState,
  type EnterpriseCreditStore,
  FleetStoreError,
} from "./enterprise-credit-store";

export const CREDIT_LIMIT_SATS = 2_000;
export const CREDIT_TRUST_THRESHOLD = 50;
export const CREDIT_IDLE_MS = 15 * 60_000;
export const CREDIT_TAB_PATH = "/api/v1/enterprise/credit-tab";
export const FLEET_REGISTER_PATH = "/api/v1/fleet/register";
export const FLEET_STATEMENT_PATH = "/api/v1/fleet/statement";
const SETTLE_PATH = CREDIT_TAB_PATH + "/settle";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// JSONB may reorder object keys; compare routing meaning, not serialization order.
const routingKey = (routing: CreditState["routing"]) =>
  JSON.stringify([
    routing?.payout ?? null,
    routing?.parentPayout ?? null,
    routing?.verificationAllocation?.origin_pubkey ?? null,
    routing?.verificationAllocation?.proof_hash ?? null,
    routing?.verificationAllocation?.caller_pubkey ?? null,
  ]);

export class CreditTabError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class EnterpriseCreditTabs {
  constructor(
    readonly store: EnterpriseCreditStore = createPostgresEnterpriseCreditStore(),
    readonly now = Date.now,
  ) {}
  async registerFleet(pubkey: string, body: unknown, eventId: string) {
    if (!/^[0-9a-f]{64}$/.test(eventId))
      throw new CreditTabError(401, "Invalid NIP-98 event id");
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new CreditTabError(
        400,
        "Provide add and/or remove arrays of Worker pubkeys",
      );
    const input = body as Record<string, unknown>;
    const valid = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.length <= 1000 &&
      value.every(
        (key) =>
          typeof key === "string" &&
          /^[0-9a-f]{64}$/.test(key) &&
          key !== pubkey,
      );
    if (
      Object.keys(input).some((key) => key !== "add" && key !== "remove") ||
      !valid(input.add === undefined ? [] : input.add) ||
      !valid(input.remove === undefined ? [] : input.remove) ||
      (input.add === undefined && input.remove === undefined)
    )
      throw new CreditTabError(
        400,
        "Use only add/remove arrays of up to 1000 distinct non-self lowercase hex pubkeys",
      );
    const add = [...new Set((input.add ?? []) as string[])];
    const remove = [...new Set((input.remove ?? []) as string[])];
    if (add.some((key) => remove.includes(key)))
      throw new CreditTabError(
        400,
        "A Worker cannot be both added and removed",
      );
    try {
      return await this.store.transaction(
        pubkey,
        async (tx) => {
          if (tx.account.trust_score <= CREDIT_TRUST_THRESHOLD)
            throw new CreditTabError(
              403,
              "Commander requires more than 50 verified paid invoices",
            );
          if (!tx.updateFleet)
            throw new CreditTabError(503, "Fleet storage unavailable");
          const workers = await tx.updateFleet(add, remove, eventId);
          return {
            commander_pubkey: pubkey,
            workers,
            maximum_unpaid_sats: CREDIT_LIMIT_SATS,
          };
        },
        { manageFleet: true },
      );
    } catch (error) {
      if (error instanceof FleetStoreError)
        throw new CreditTabError(error.status, error.message);
      throw error;
    }
  }
  summary(account: CreditAccount) {
    return {
      pubkey: account.pubkey,
      trust_score: account.trust_score,
      successfully_settled_invoices: account.trust_score,
      credit_eligible: account.trust_score > CREDIT_TRUST_THRESHOLD,
      state: account.state.due
        ? "settlement_due"
        : account.trust_score > CREDIT_TRUST_THRESHOLD
          ? "credit_tab"
          : "standard",
      session_id: account.state.sessionId,
      unpaid_sats: account.unpaid_sats,
      yield_credit_msats: account.yield_credit_msats,
      yield_credit_sats: account.yield_credit_msats / 1000,
      balance_msats: account.unpaid_sats * 1000 - account.yield_credit_msats,
      balance_sats:
        (account.unpaid_sats * 1000 - account.yield_credit_msats) / 1000,
      payable_sats: Math.max(
        0,
        account.unpaid_sats - Math.floor(account.yield_credit_msats / 1000),
      ),
      maximum_unpaid_sats: CREDIT_LIMIT_SATS,
      idle_timeout_seconds: CREDIT_IDLE_MS / 1000,
      settlement_endpoint: SETTLE_PATH,
      close_endpoint: CREDIT_TAB_PATH + "/close",
    };
  }
  async status(pubkey: string, close = false) {
    return this.store.transaction(pubkey, async ({ account }) => {
      if (
        account.unpaid_sats &&
        (close || this.now() - account.state.lastActivity >= CREDIT_IDLE_MS)
      )
        account.state.due = true;
      return this.summary(account);
    });
  }
  async statement(pubkey: string) {
    const snapshot = await this.store.statement(pubkey);
    if (
      !snapshot ||
      snapshot.isWorker ||
      snapshot.account.trust_score <= CREDIT_TRUST_THRESHOLD
    )
      throw new CreditTabError(403, "Statement requires a VIP Commander");
    const { account, lifetimeYieldMsats } = snapshot;
    const pending = account.state.invoices.at(-1);
    return {
      commander_pubkey: account.pubkey,
      session_id: account.state.sessionId,
      state: account.state.due ? "settlement_due" : "credit_tab",
      gross_unpaid_sats: account.unpaid_sats,
      balance_msats: account.unpaid_sats * 1000 - account.yield_credit_msats,
      yield_credit_msats: account.yield_credit_msats,
      yield_applied_msats: pending?.yieldAppliedMsats ?? 0,
      lifetime_yield_earned_msats: lifetimeYieldMsats,
    };
  }
  async recordPaid(
    pubkey: string,
    provider: string,
    paymentHash: string,
    amountSats: number,
  ) {
    if (
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !/^[0-9a-f]{64}$/.test(paymentHash) ||
      !Number.isSafeInteger(amountSats) ||
      amountSats < 1
    )
      throw new Error("Invalid paid invoice reputation record");
    await this.store.transaction(pubkey, async (tx) => {
      const existing = await tx.paid(paymentHash);
      if (
        existing &&
        (existing.pubkey !== pubkey ||
          existing.provider !== provider ||
          existing.amount_sats !== amountSats)
      )
        throw new CreditTabError(
          403,
          "Invoice reputation belongs to a different buyer or payment",
        );
      await tx.recordPaid(paymentHash, provider, amountSats, "l402");
    });
  }
  /** Called only after fresh NIP-98 verification by the existing L402 gate.
   * Commit the debt and replay reservation before any tool or external effect.
   */
  async admit(
    req: Request,
    res: Response,
    pubkey: string,
    amountSats: number,
    scope: string,
    router: SettlementRouter,
    secret: string,
  ): Promise<"standard" | "admitted" | "response"> {
    if (
      /^\/invoice\/request\/?$/i.test(req.path) ||
      req.get("X-L402-Batch-Size")
    )
      return "standard";
    if (!secret)
      throw new CreditTabError(503, "Credit tab signing unavailable");
    const event = JSON.parse(
      Buffer.from(
        requestNip98Authorization(req)!.slice(6),
        "base64",
      ).toString(),
    );
    if (!/^[0-9a-f]{64}$/.test(event.id))
      throw new CreditTabError(401, "Invalid NIP-98 event id");
    const context = enterpriseContext.getStore();
    const routing = {
      payout: context?.payout,
      parentPayout: context?.parentPayout,
      verificationAllocation: context?.verificationAllocation,
    };
    const outcome = await this.store.transaction(
      pubkey,
      async (tx) => {
        const a = tx.account;
        const delegated = a.pubkey !== pubkey;
        // A Worker may spend credit but may not redirect the owner's allocation.
        const billingRouting = delegated ? (a.state.routing ?? {}) : routing;
        if (a.trust_score <= CREDIT_TRUST_THRESHOLD)
          return { kind: "standard" } as const;
        if (!Number.isSafeInteger(amountSats) || amountSats < 1)
          throw new Error("Invalid credit toll");
        if (
          a.unpaid_sats &&
          (this.now() - a.state.lastActivity >= CREDIT_IDLE_MS ||
            routingKey(a.state.routing) !== routingKey(billingRouting) ||
            a.unpaid_sats + amountSats > CREDIT_LIMIT_SATS)
        )
          a.state.due = true;
        if (a.state.due) return { kind: "due", commander: a.pubkey } as const;
        // A single operation larger than the tab limit must use the existing prepaid lane.
        if (amountSats > CREDIT_LIMIT_SATS)
          return { kind: "standard" } as const;
        const requestHash = hash(
          JSON.stringify([
            req.method,
            req.originalUrl,
            scope,
            req.body,
            amountSats,
          ]),
        );
        if (!(await tx.charge(event.id, requestHash, amountSats)))
          throw new CreditTabError(
            409,
            "NIP-98 credit admission already reserved; execution was not repeated",
          );
        a.unpaid_sats += amountSats;
        a.state.lastActivity = this.now();
        a.state.routing = billingRouting;
        if (a.unpaid_sats === CREDIT_LIMIT_SATS) a.state.due = true;
        return {
          kind: "admitted",
          credit: {
            ...this.summary(a),
            ...(delegated
              ? { commander_pubkey: a.pubkey, worker_pubkey: pubkey }
              : {}),
            charge_id: event.id,
            request_sha256: requestHash,
          },
        } as const;
      },
      { routeFleet: true },
    );
    if (outcome.kind === "standard") return "standard";
    if (outcome.kind === "due") {
      const invoice = await this.invoice(outcome.commander, router, secret);
      if ("invoice" in invoice && "macaroon" in invoice)
        res.setHeader(
          "WWW-Authenticate",
          `L402 macaroon="${invoice.macaroon}", invoice="${invoice.invoice}"`,
        );
      res.setHeader("Cache-Control", "no-store");
      res.locals.creditTabSettlement = true;
      res.status("invoice" in invoice ? 402 : 409).json(invoice);
      return "response";
    }
    res.locals.creditTab = outcome.credit;
    res.setHeader(
      "X-Credit-Tab-Balance-Sats",
      String(outcome.credit.unpaid_sats),
    );
    res.setHeader("X-Credit-Tab-Session", outcome.credit.session_id);
    res.setHeader("X-Credit-Tab-State", outcome.credit.state);
    res.setHeader(
      "Link",
      `<${SETTLE_PATH}>; rel="payment"; type="application/json"`,
    );
    return "admitted";
  }
  /** Freeze the whole tab. Only one worker can issue/reuse its pending invoice. */
  async invoice(pubkey: string, router: SettlementRouter, secret: string) {
    if (!secret) throw new Error("Credit tab signing is unavailable");
    await this.status(pubkey, true); // Closing survives a subsequent wallet failure.
    return this.store.transaction(pubkey, async ({ account: a }) => {
      if (!a.unpaid_sats) return { ...this.summary(a), status: "settled" };
      // Only confirmed payments create yield. Spending that yield can close a
      // small tab without a zero-value invoice or another yield/reputation grant.
      if (
        !a.state.invoices.length &&
        a.yield_credit_msats >= a.unpaid_sats * 1000
      ) {
        const applied = a.unpaid_sats * 1000;
        a.yield_credit_msats -= applied;
        a.unpaid_sats = 0;
        a.state = newCreditState(this.now());
        return {
          ...this.summary(a),
          status: "credit_applied",
          yield_applied_msats: applied,
          retry_required: true,
        };
      }
      let invoice = a.state.invoices.at(-1);
      if (invoice && invoice.expiresAt <= this.now()) {
        // Do not replace a possibly paid invoice during an outage. Keep old
        // references so delayed proofs still bind the same frozen tab.
        const settled = await router.verifyPayment({
          paymentHash: invoice.paymentHash,
          preimage: "nwc_lookup",
          verificationMode: "merchant-lookup",
          expectedAmountMsats: invoice.amountSats * 1000,
          expectedDescription: invoice.description,
          expectedProvider: invoice.provider,
          asset: "btc-lightning",
        });
        if (settled === "unavailable")
          throw new CreditTabError(
            503,
            "Previous tab invoice settlement unavailable",
          );
        if (typeof settled === "object")
          throw new CreditTabError(
            409,
            "Previous tab invoice is paid; redeem its L402 credential at the settlement endpoint",
          );
        invoice = undefined;
      }
      if (!invoice) {
        const grossAmountSats = a.unpaid_sats;
        // Existing payment/revenue ledgers require integer sats. Keep any
        // fractional sat in the treasury instead of rounding away earned yield.
        const yieldAppliedMsats = Math.min(
          Math.floor(a.yield_credit_msats / 1000) * 1000,
          grossAmountSats * 1000,
        );
        const amountSats = grossAmountSats - yieldAppliedMsats / 1000;
        const description = `Bitcoin Stratigraphy credit tab ${a.state.sessionId}`;
        const outer = enterpriseContext.getStore();
        const context = {
          ...outer,
          payout: a.state.routing?.payout,
          parentPayout: a.state.routing?.parentPayout,
          verificationAllocation: a.state.routing?.verificationAllocation,
          buyer: pubkey,
          invoices: new Map(),
          account: outer?.buyer === pubkey ? outer.account : undefined,
        };
        const created = await enterpriseContext.run(context, () =>
          router.createInvoice({
            amountMsats: amountSats * 1000,
            description,
            expirySeconds: 3600,
            asset: "btc-lightning",
          }),
        );
        if (
          !created.invoice.startsWith("ln") ||
          !/^[0-9a-f]{64}$/.test(created.paymentHash) ||
          !created.provider ||
          (created.asset && created.asset !== "btc-lightning")
        )
          throw new Error("Invalid credit tab settlement invoice");
        const root = enterpriseContext.run(context, () =>
          createSubscriptionMacaroon({
            secret,
            paymentHash: created.paymentHash,
            tier: "1-day",
            validUntil: Math.floor(this.now() / 1000) + 3600,
            amountMsats: amountSats * 1000,
            paymentAsset: "btc-lightning",
            paymentProvider: created.provider,
            agentId: pubkey,
            agentAuthentication: "nip98",
          }),
        );
        const macaroon = attenuateSubscriptionMacaroon(root, [
          `allowed_path=${SETTLE_PATH}`,
          "max_requests=1",
        ]);
        if (!macaroon) throw new Error("Unable to bind credit tab invoice");
        invoice = {
          ...created,
          macaroon,
          amountSats,
          grossAmountSats,
          yieldAppliedMsats,
          description,
          expiresAt: this.now() + 3600_000,
        };
        a.state.invoices.push(invoice);
      }
      return {
        ...this.summary(a),
        error: "Full credit tab settlement required",
        invoice: invoice.invoice,
        macaroon: invoice.macaroon,
        payment_hash: invoice.paymentHash,
        amount_sats: invoice.amountSats,
        gross_amount_sats: invoice.grossAmountSats ?? invoice.amountSats,
        yield_applied_msats: invoice.yieldAppliedMsats ?? 0,
        merchant_msats: invoice.amountSats * 790,
        allocation_pool_msats: invoice.amountSats * 210,
      };
    });
  }
  async settle(
    pubkey: string,
    authorization: string | undefined,
    router: SettlementRouter,
    secret: string,
    ledger?: RevenueLedger,
  ) {
    const credential = parseL402Header(authorization);
    const pass =
      credential && inspectSubscriptionMacaroon(credential.macaroon, secret);
    if (
      !pass ||
      pass.agentId !== pubkey ||
      pass.agentAuthentication !== "nip98" ||
      pass.allowedPaths.length !== 1 ||
      pass.allowedPaths[0] !== SETTLE_PATH ||
      pass.delegatePubkey ||
      pass.paymentAsset !== "btc-lightning"
    )
      throw new CreditTabError(
        403,
        "Provide this identity's exact credit tab L402 settlement credential",
      );
    return this.store.transaction(pubkey, async (tx) => {
      const a = tx.account;
      const previous = await tx.paid(pass.paymentHash);
      if (previous) {
        if (previous.pubkey !== pubkey || previous.source !== "credit-tab")
          throw new CreditTabError(
            403,
            "Payment is not this identity's credit tab settlement",
          );
        return { ...this.summary(a), status: "already_settled" };
      }
      const invoice = a.state.invoices.find(
        (i) => i.paymentHash === pass.paymentHash,
      );
      if (
        !invoice ||
        invoice.macaroon !== credential!.macaroon ||
        (invoice.grossAmountSats ?? invoice.amountSats) !== a.unpaid_sats ||
        (invoice.yieldAppliedMsats ?? 0) > a.yield_credit_msats ||
        invoice.amountSats * 1000 + (invoice.yieldAppliedMsats ?? 0) !==
          a.unpaid_sats * 1000 ||
        pass.amountMsats !== invoice.amountSats * 1000 ||
        invoice.provider !== pass.paymentProvider ||
        !a.state.due
      )
        throw new CreditTabError(
          403,
          "Payment does not match the complete frozen tab",
        );
      // This endpoint confirms historical debt, not live tool authorization.
      // An authentic expired credential may therefore confirm its exact invoice.
      const proof = credential!.preimage;
      if (
        /^[0-9a-f]{64}$/.test(proof) &&
        createHash("sha256").update(Buffer.from(proof, "hex")).digest("hex") !==
          invoice.paymentHash
      )
        throw new CreditTabError(403, "Invalid tab payment preimage");
      const verified = await router.verifyPayment({
        paymentHash: invoice.paymentHash,
        ...paymentVerificationProof(proof),
        expectedAmountMsats: invoice.amountSats * 1000,
        expectedDescription: invoice.description,
        expectedProvider: invoice.provider,
        asset: "btc-lightning",
      });
      if (verified === "unavailable")
        throw new CreditTabError(
          503,
          "Tab settlement verification unavailable",
        );
      if (verified === "invalid")
        throw new CreditTabError(409, "Entire tab invoice is not settled");
      if (
        verified.provider !== invoice.provider ||
        (verified.asset && verified.asset !== "btc-lightning")
      )
        throw new CreditTabError(403, "Tab payment provider or asset mismatch");
      if (ledger)
        await recordRevenueWithRetry(ledger, {
          id: randomUUID(),
          timestamp: new Date(
            verified.settledAt < 10_000_000_000
              ? verified.settledAt * 1000
              : verified.settledAt,
          ).toISOString(),
          channel: "L402",
          requestKind: "stratigraphy",
          satsReceived: invoice.amountSats,
          paymentHash: invoice.paymentHash,
          clientIdentifier: pubkey,
          ...(/^[0-9a-f]{64}$/.test(proof)
            ? { preimage: proof }
            : { merchantVerified: true as const }),
        });
      await tx.recordPaid(
        invoice.paymentHash,
        invoice.provider,
        invoice.amountSats,
        "credit-tab",
      );
      // Integer-msat arithmetic is exact: 21% of each paid sat is 210 msats.
      // Apply only once in the same locked transaction as the payment receipt.
      const earnedYieldMsats = invoice.amountSats * 210;
      a.yield_credit_msats =
        a.yield_credit_msats -
        (invoice.yieldAppliedMsats ?? 0) +
        earnedYieldMsats;
      a.unpaid_sats = 0;
      a.state = newCreditState(this.now());
      return {
        ...this.summary(a),
        status: "settled",
        payment_hash: invoice.paymentHash,
        yield_earned_msats: earnedYieldMsats,
      };
    });
  }
}

export function verifiedCreditIdentity(req: Request): string {
  const signer = verifyRequestNip98Signer(req, Date.now());
  if (!signer.provided || !signer.pubkey)
    throw new CreditTabError(401, "Fresh NIP-98 authentication required");
  const declaration = declaredAgentId(req);
  if (
    !declaration.ok ||
    (declaration.agentId && declaration.agentId !== signer.pubkey)
  )
    throw new CreditTabError(
      403,
      "Agent declaration must match the NIP-98 signer",
    );
  return signer.pubkey;
}
