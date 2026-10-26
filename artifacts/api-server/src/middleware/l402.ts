import { attachLicensingCompliance, licensingCompliance, logLicensingSettlement } from "../lib/licensing-compliance";
import { createHash, randomUUID } from "node:crypto";
import { clientKey } from "../lib/client-address";
import { L402EdgeCache } from "../lib/l402-edge-cache";
import type { createInvoicePow } from "../lib/invoice-pow";
import type { Request, RequestHandler, Response } from "express";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  delegationCaveatRejection,
  inspectSubscriptionMacaroon,
} from "../lib/subscription-pass";
import { MCP_TOOL_NAME_PATTERN } from "../lib/delegation-caveats";
import {
  AGENT_ID_HEADER,
  agentBindingRejection,
  declaredAgentId,
  type AgentAuthentication,
} from "../lib/agent-id-caveat";
import { verifyRequestNip98Signer } from "../lib/nip98-request";
import { assertEnterpriseVerificationTarget } from "../lib/enterprise-economics";
import {
  createMemoryMacaroonUsageStore,
  type MacaroonUsageStore,
} from "../lib/macaroon-usage-store";
import type { SettlementRouter } from "../services/settlement";
import type { RevenueLedger, RevenueRequestKind } from "../services/ledger";
import type { MacaroonRevocationStore } from "../lib/macaroon-revocation-store";
import { paymentReference, recordRevenueWithRetry } from "../services/ledger";
import { awaitingPaymentPreview, expectedRestOutputSchema, l402ChallengeGuidance } from "../lib/agent-conversion";

export type L402Authorization = {
  macaroon: string;
  preimage: string;
};

export type L402MiddlewareOptions = {
  amountSats: number | ((req: Request) => number);
  description: string;
  settlementRouter: SettlementRouter;
  scopePath?: string | ((req: Request) => string);
  enforceCurrentAmount?: boolean;
  sessionSecret?: string;
  invoiceExpirySeconds?: number;
  now?: () => number;
  usageStore?: MacaroonUsageStore;
  maxChallengesPerMinute?: number;
  ledger?: RevenueLedger;
  revocationStore?: MacaroonRevocationStore;
  requestKind?: RevenueRequestKind;
  allowBatch?: boolean;
  /** Enable only for new MCP invoices, never for settlement verification. */
  invoicePow?: ReturnType<typeof createInvoicePow>;
  expectedOutputSchema?: Record<string, unknown> | ((req: Request) => Record<string, unknown>);
  /**
   * Exact MCP tool this route executes, checked against `rpc` and
   * `allowed_tools` caveats. Without it, tool or target scoped credentials are
   * refused. MCP callers must enforce `max_target` before invoking the gate.
   */
  tool?: string;
};

export function parseL402Header(
  value: string | undefined,
): L402Authorization | null {
  const match =
    /^L402\s+([^:\s]+)(?::([0-9a-fA-F]{64}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|NWC_LOOKUP)?)?$/i.exec(
      value?.trim() ?? "",
    );
  return match
    ? { macaroon: match[1]!, preimage: match[2]?.toLowerCase() ?? "nwc_lookup" }
    : null;
}

export function paymentVerificationProof(preimage: string) {
  return { preimage, ...(!/^[0-9a-f]{64}$/.test(preimage)
    ? { verificationMode: "merchant-lookup" as const } : {}) };
}

export function createL402Middleware(
  options: L402MiddlewareOptions,
): RequestHandler {
  if (typeof options.scopePath === "string" && !/^\/[^\s]*$/.test(options.scopePath)) {
    throw new RangeError("L402 scopePath must be an absolute path");
  }
  if (options.tool !== undefined && !MCP_TOOL_NAME_PATTERN.test(options.tool)) {
    throw new RangeError("L402 tool must be an MCP tool name");
  }
  if (
    !Number.isSafeInteger(options.invoiceExpirySeconds ?? 3_600) ||
    (options.invoiceExpirySeconds ?? 3_600) <= 0
  ) {
    throw new RangeError(
      "L402 invoiceExpirySeconds must be a positive integer",
    );
  }
  if (
    !Number.isSafeInteger(options.maxChallengesPerMinute ?? 10) ||
    (options.maxChallengesPerMinute ?? 10) <= 0
  ) {
    throw new RangeError(
      "L402 maxChallengesPerMinute must be a positive integer",
    );
  }
  const resolveAmountSats = (req?: Request) => {
    const amount =
      typeof options.amountSats === "function"
        ? options.amountSats(req!)
        : options.amountSats;
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
    ) {
      throw new RangeError("L402 amountSats must be a positive integer");
    }
    return amount;
  };
  if (typeof options.amountSats === "number") resolveAmountSats();
  const resolveScope = (req: Request) =>
    typeof options.scopePath === "function" ? options.scopePath(req) : options.scopePath ?? req.path;
  const invoiceExpirySeconds = options.invoiceExpirySeconds ?? 3_600;
  const now = options.now ?? Date.now;
  const credentialCache = new L402EdgeCache<
    NonNullable<ReturnType<typeof inspectSubscriptionMacaroon>>
  >(now);
  const settlementCache = new L402EdgeCache<
    Awaited<ReturnType<SettlementRouter["verifyPayment"]>>
  >(now);
  const usageStore = options.usageStore ?? createMemoryMacaroonUsageStore(now);
  const maxChallengesPerMinute = options.maxChallengesPerMinute ?? 10;
  const challengeWindows = new Map<
    string,
    { startedAt: number; count: number }
  >();
  const maxChallengeCallers = 10_000;
  let challengeWindowsCleanedAt = 0;

  const sendChallenge = async (
    req: Request,
    res: Response,
    agent?: { agentId: string; authentication?: AgentAuthentication },
  ) => {
    const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
    if (!secret) {
      res.status(500).json({ error: "SESSION_SECRET is not configured" });
      return;
    }
    if (!options.settlementRouter.isConfigured("btc-lightning")) {
      res.status(500).json({ error: "Lightning settlement is not configured" });
      return;
    }
    const requestedBatch = req.get("X-L402-Batch-Size");
    if (requestedBatch && (!options.allowBatch || requestedBatch !== "100")) {
      res.status(400).json({error: "X-L402-Batch-Size must be 100 on a batch-capable route"});
      return;
    }
    if (options.invoicePow) {
      const binding = createHash("sha256").update(JSON.stringify([
        req.method, resolveScope(req), req.query, req.body ?? null,
        resolveAmountSats(req), requestedBatch ?? null, options.description, agent ?? null,
      ])).digest("hex");
      if (!await options.invoicePow.admit(req, res, binding, secret)) return;
    }
    const caller = clientKey(req);
    const currentTime = now();
    if (
      currentTime - challengeWindowsCleanedAt >= 60_000 ||
      challengeWindows.size >= maxChallengeCallers
    ) {
      for (const [key, candidate] of challengeWindows) {
        if (currentTime - candidate.startedAt >= 60_000) {
          challengeWindows.delete(key);
        }
      }
      challengeWindowsCleanedAt = currentTime;
    }
    if (
      !challengeWindows.has(caller) &&
      challengeWindows.size >= maxChallengeCallers
    ) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Too many payment challenges requested" });
      return;
    }
    const currentWindow = challengeWindows.get(caller);
    const window =
      !currentWindow || currentTime - currentWindow.startedAt >= 60_000
        ? { startedAt: currentTime, count: 0 }
        : currentWindow;
    window.count += 1;
    challengeWindows.set(caller, window);
    if (window.count > maxChallengesPerMinute) {
      res.setHeader(
        "Retry-After",
        String(
          Math.max(
            1,
            Math.ceil((60_000 - (currentTime - window.startedAt)) / 1_000),
          ),
        ),
      );
      res.status(429).json({ error: "Too many payment challenges requested" });
      return;
    }
    try {
      const requestedBatch = req.get("X-L402-Batch-Size");
      if (requestedBatch && (!options.allowBatch || requestedBatch !== "100")) {
        res.status(400).json({
          error: "X-L402-Batch-Size must be 100 on a batch-capable route",
        });
        return;
      }
      const batchSize = requestedBatch ? 100 : 1;
      const amountSats = resolveAmountSats(req) * batchSize;
      if (!Number.isSafeInteger(amountSats * 1_000))
        throw new RangeError("Batch price exceeds safe range");
      const amountMsats = amountSats * 1_000;
      const invoice = await options.settlementRouter.createInvoice({
        amountMsats,
        description:
          batchSize === 100
            ? `${options.description} (100-call batch)`
            : options.description,
        expirySeconds: invoiceExpirySeconds,
        asset: "btc-lightning",
      });
      if (
        typeof invoice.invoice !== "string" ||
        !invoice.invoice.startsWith("ln") ||
        !/^[0-9a-f]{64}$/.test(invoice.paymentHash) ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(invoice.provider)
      ) {
        throw new Error("Settlement provider returned an invalid invoice");
      }
      const rootMacaroon = createSubscriptionMacaroon({
        secret,
        paymentHash: invoice.paymentHash,
        tier: "1-day",
        validUntil: Math.floor(now() / 1_000) + invoiceExpirySeconds,
        amountMsats,
        paymentAsset: "btc-lightning",
        paymentProvider: invoice.provider,
        ...(agent === undefined
          ? {}
          : {
              agentId: agent.agentId,
              ...(agent.authentication === undefined
                ? {}
                : { agentAuthentication: agent.authentication }),
            }),
      });
      const macaroon = attenuateSubscriptionMacaroon(rootMacaroon, [
        `allowed_path=${resolveScope(req)}`,
        `max_requests=${batchSize}`,
      ]);
      if (!macaroon) throw new Error("Unable to attenuate L402 macaroon");
      res.setHeader(
        "WWW-Authenticate",
        `L402 macaroon="${macaroon}", invoice="${invoice.invoice}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(402).json({
        error: "Payment required",
        licensing_compliance: licensingCompliance,
        macaroon,
        invoice: invoice.invoice,
        payment_hash: invoice.paymentHash,
        amount_sats: amountSats,
        max_requests: batchSize,
        ...(agent === undefined ? {} : { agent_id: agent.agentId }),
        ...(agent?.authentication === undefined
          ? {}
          : { agent_authentication: agent.authentication }),
        ...l402ChallengeGuidance(),
        staged_preview: awaitingPaymentPreview(amountSats,
          typeof options.expectedOutputSchema === "function" ? options.expectedOutputSchema(req)
            : options.expectedOutputSchema ?? expectedRestOutputSchema(req)),
      });
    } catch (error) {
      req.log?.error({ err: error }, "L402 invoice creation failed");
      res.status(502).json({ error: "Unable to create payment invoice" });
    }
  };

  return async (req, res, next) => {
    // Optional sub-agent attribution (X-Agent-Id or body agent_id). Malformed
    // or conflicting declarations never reach a challenge or the wallet.
    const declaration = declaredAgentId(req);
    if (!declaration.ok) {
      res.status(400).json({ error: declaration.error });
      return;
    }
    // Optional NIP-98 proof of the agent: `Authorization: Nostr <event>` on a
    // challenge request, X-Nostr-Authorization beside an L402 credential. The
    // Schnorr-signed event must bind this URL, method and exact body. A
    // present but invalid or forged event is refused before any invoice.
    const signer = verifyRequestNip98Signer(req, now());
    if (signer.provided && signer.pubkey === null) {
      res.status(401).json({ error: "Invalid NIP-98 authorization" });
      return;
    }
    const nip98Pubkey = signer.provided ? signer.pubkey ?? undefined : undefined;
    if (
      nip98Pubkey !== undefined &&
      declaration.agentId !== undefined &&
      declaration.agentId !== nip98Pubkey
    ) {
      res.status(400).json({
        error: `${AGENT_ID_HEADER} and body agent_id must equal the NIP-98 signer pubkey`,
      });
      return;
    }
    const secret = options.sessionSecret ?? process.env.SESSION_SECRET;
    const authorization = parseL402Header(req.header("Authorization"));
    if (secret && authorization) {
      const credentialKey = L402EdgeCache.key(secret, authorization.macaroon);
      const requestTime = now();
      const authentic =
        credentialCache.get(credentialKey) ??
        inspectSubscriptionMacaroon(authorization.macaroon, secret);
      // An expired root credential renews through a fresh 402 challenge.
      const pass =
        authentic && authentic.validUntil * 1_000 > requestTime
          ? authentic
          : null;
      if (pass) {
        try { await assertEnterpriseVerificationTarget(pass.paymentHash); }
        catch (error) {
          res.status(error instanceof RangeError ? 403 : 503).json({error: error instanceof RangeError ? error.message : "Invoice allocation validation unavailable"});
          return;
        }
        credentialCache.set(
          credentialKey,
          pass,
          pass.expiresAt ?? pass.validUntil * 1_000,
        );
        // Delegated deadlines, tool scope and agent binding are refused
        // explicitly, before any revocation, wallet, or usage-quota work.
        const rejection =
          delegationCaveatRejection(pass, {
            nowMs: requestTime,
            tool: options.tool,
          }) ??
          agentBindingRejection(pass, {
            declared: declaration.agentId,
            nip98Pubkey,
          });
        if (rejection) {
          res.status(rejection.status).json({ error: rejection.error });
          return;
        }
        if (pass.delegatePubkey && pass.agentAuthentication === "nip98" && pass.agentId) {
          try {
            if (await req.app.locals.swarmProtocol?.revoked(pass.agentId)) {
              res.status(401).json({error: "Delegating agent is revoked"}); return;
            }
          } catch {
            res.status(503).json({error: "Delegating agent revocation unavailable"}); return;
          }
        }
        if (options.revocationStore) {
          try {
            const ids = pass.delegatePubkey || pass.requestLimits[0]?.maxRequests === 100
              ? [...(pass.ancestorTokenIds ?? []), pass.tokenId] : [pass.tokenId];
            let revoked = false;
            for (const id of ids) {
              if (await options.revocationStore.isRevoked(id)) { revoked = true; break; }
            }
            if (revoked) {
              res.status(401).json({ error: "Macaroon is revoked" });
              return;
            }
          } catch (error) {
            req.log?.error({ err: error }, "L402 revocation lookup failed");
            res.status(503).json({ error: "Revocation lookup unavailable" });
            return;
          }
        }
      }
      const preimageHash = /^[0-9a-f]{64}$/.test(authorization.preimage)
        ? createHash("sha256")
            .update(Buffer.from(authorization.preimage, "hex"))
            .digest("hex")
        : null;
      if (
        pass &&
        (pass.paymentHash === preimageHash || preimageHash === null) &&
        pass.amountMsats !== undefined &&
        pass.amountMsats > 0 &&
        (typeof options.amountSats !== "number" && !options.enforceCurrentAmount ||
          pass.amountMsats ===
            resolveAmountSats(req) *
              1_000 *
              (options.allowBatch && pass.requestLimits[0]?.maxRequests === 100
                ? 100
                : 1)) &&
        pass.paymentAsset === "btc-lightning" &&
        pass.paymentProvider &&
        pass.allowedPaths.length > 0 &&
        pass.allowedPaths.every(
          (path) => path === resolveScope(req),
        )
      ) {
        let verification;
        try {
          const batch =
            options.allowBatch && pass.requestLimits[0]?.maxRequests === 100;
          const description = batch
            ? `${options.description} (100-call batch)`
            : options.description;
          const expectedAmountMsats = pass.amountMsats;
          const settlementKey = L402EdgeCache.key(
            secret,
            pass.paymentHash,
            preimageHash === null ? "merchant-lookup" : authorization.preimage,
            pass.paymentProvider,
            String(pass.amountMsats),
            description,
            resolveScope(req),
          );
          verification = await settlementCache.resolve(
            settlementKey,
            pass.validUntil * 1_000,
            () =>
              options.settlementRouter.verifyPayment({
                paymentHash: pass.paymentHash,
                preimage: authorization.preimage,
                ...(preimageHash === null ? { verificationMode: "merchant-lookup" as const } : {}),
                expectedAmountMsats,
                expectedDescription: description,
                expectedProvider: pass.paymentProvider,
                asset: "btc-lightning",
              }),
            (value) => typeof value === "object" && value !== null,
          );
        } catch (error) {
          req.log?.error({ err: error }, "L402 payment verification failed");
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (verification === "unavailable") {
          res.status(502).json({ error: "Unable to verify payment" });
          return;
        }
        if (typeof verification === "object") {
          if ((pass.expiresAt ?? pass.validUntil * 1_000) <= now()) {
            res
              .status(401)
              .json({ error: "L402 macaroon expired during verification" });
            return;
          }
          if (
            pass.maxRequests !== undefined &&
            !(await usageStore.consume(pass.requestLimits, pass.validUntil))
          ) {
            res
              .status(429)
              .json({ error: "L402 macaroon has already been used" });
            return;
          }
          if (options.ledger) {
            try {
              await recordRevenueWithRetry(options.ledger, {
                id: randomUUID(),
                timestamp: new Date(
                  verification.settledAt < 10_000_000_000
                    ? verification.settledAt * 1_000
                    : verification.settledAt,
                ).toISOString(),
                channel: "L402",
                requestKind: options.requestKind ?? "stratigraphy",
                satsReceived: Math.ceil(pass.amountMsats / 1_000),
                paymentHash: pass.paymentHash,
                ...(/^[0-9a-f]{64}$/.test(authorization.preimage)
                  ? { preimage: authorization.preimage }
                  : { merchantVerified: true as const }),
                clientIdentifier: clientKey(req),
              });
            } catch (error) {
              req.log?.error(
                {
                  err: error,
                  paymentReference: paymentReference(pass.paymentHash),
                },
                "L402 settlement ledger failed",
              );
            }
          }
          res.locals.l402 = {
            ...(pass.delegatePubkey ? {delegatePubkey: pass.delegatePubkey} : {}),
            paymentHash: pass.paymentHash,
            settledAt: verification.settledAt,
            provider: verification.provider,
            ...(pass.agentId === undefined ? {} : { agentId: pass.agentId }),
            ...(pass.agentAuthentication === undefined
              ? {}
              : { agentAuthentication: pass.agentAuthentication }),
          };
          attachLicensingCompliance(res);
          logLicensingSettlement(req);
          next();
          return;
        }
        if (preimageHash === null) {
          // Retain the original invoice while wallet state catches up. Never
          // replace a possibly paid invoice merely because a lookup is pending.
          res.status(409).json({
            error: "Payment is not confirmed yet. Keep the original invoice and retry verification.",
            payment_hash: pass.paymentHash,
            verification_pending: true,
          });
          return;
        }
      }
    }
    // A verified signer becomes the authenticated agent_id; otherwise any
    // self-declared agent_id is bound unauthenticated.
    await sendChallenge(
      req,
      res,
      nip98Pubkey !== undefined
        ? { agentId: nip98Pubkey, authentication: "nip98" }
        : declaration.agentId === undefined
          ? undefined
          : { agentId: declaration.agentId },
    );
  };
}
