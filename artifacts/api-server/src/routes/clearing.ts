// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash, createHmac, ECDH } from "node:crypto";
import type { RequestHandler } from "express";
import { z } from "zod";
import {
  verifyRequestNip98Signer,
  requestNip98Payload,
} from "../lib/nip98-request";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
} from "../lib/subscription-pass";
import type { SettlementRouter } from "../services/settlement";
import type {
  ClearingContract,
  ClearingContracts,
} from "../services/clearingContracts";
import {
  signClearingReceipt,
  verifyClearingExecution,
} from "../services/clearingExecution";
import { activeClearingKeys } from "../services/clearingKeys";
import {
  CLEARING_PAYOUT_DISABLED,
  settleClearingContractPayout,
} from "../services/clearingPayout";
import { LndPayoutError } from "../adapters/lnd";

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const workerKey = hex32.refine((key) => {
  try {
    ECDH.convertKey(Buffer.from(`02${key}`, "hex"), "secp256k1");
    return true;
  } catch {
    return false;
  }
});
const createInput = z
  .object({
    worker_pubkey: workerKey,
    task_hash: hex32,
    amount_sats: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  })
  .strict();
const settleInput = z
  .object({
    escrow_id: z.string().uuid(),
    // JSON proof envelope; never send the private preimage to the server.
    execution_trace: z
      .string()
      .min(1)
      .max(64 * 1024),
    // Bound to the exact worker by the existing NIP-98 payload signature.
    // Optional to preserve the existing no-payout development contract.
    payout_invoice: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const clearingToolDefinitions = [
  {
    name: "clearing.create_contract",
    description:
      "Create a worker contract; return its contract ID (escrow_id) and Lightning funding invoice (invoice). Requires fresh buyer NIP-98 authentication. New request IDs create separate contracts even for the same task_hash; byte-identical retries by the same buyer reuse the contract and its unexpired invoice. Funds remain merchant-controlled; an unpaid invoice is not funding. No automated payouts. Note: Contract state polling, listing, cancellations, and automated refunds are intentionally disabled in this namespace by design to enforce strict manual payout verification and prevent automated drain attacks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worker_pubkey: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description:
            "Worker's Nostr public key: exactly 64 lowercase hexadecimal characters (32-byte x-only secp256k1 key), without a 0x prefix. Must represent a valid curve point.",
          examples: [
            "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
          ],
        },
        task_hash: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description:
            "Task commitment as exactly 64 lowercase hexadecimal characters (32 bytes), without a 0x prefix. When production settlement is enabled, its numeric value must be less than 21888242871839275222246405745257275088548364400416034343698204186575808495617.",
          examples: [
            "0101010101010101010101010101010101010101010101010101010101010101",
          ],
        },
        amount_sats: {
          type: "integer",
          minimum: 1,
          maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1000),
          description:
            "Contract funding amount in whole satoshis: an integer from 1 through 9007199254740 inclusive. Fractional satoshis are not accepted.",
          examples: [123],
        },
      },
      required: ["worker_pubkey", "task_hash", "amount_sats"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "clearing.settle_contract",
    description:
      "Record a funded escrow contract as settled with a signed Groth16 preimage receipt. Production uses the Solo Founder Genesis key; opted-in local development retains its separate key and receipt domain. Requires the exact NIP-98 worker, task/escrow-bound proof and merchant-confirmed invoice funding before an atomic, idempotent evidence commit. No automated payout, arbitrary-execution guarantee or legal indemnity. Funds remain merchant-controlled. Note: Contract state polling, listing, cancellations, and automated refunds are intentionally disabled in this namespace by design to enforce strict manual payout verification and prevent automated drain attacks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        escrow_id: {
          type: "string",
          format: "uuid",
          description:
            "The escrow UUID returned by clearing.create_contract. Merchant-confirmed funding is required; an unpaid contract is not funded escrow.",
        },
        execution_trace: {
          type: "string",
          minLength: 1,
          maxLength: 65536,
          description:
            "JSON-encoded Groth16 proof envelope containing scheme, proof and publicSignals. Production scheme: 'clearing-poseidon-preimage-genesis-v1'; local development scheme: 'clearing-poseidon-preimage-development-v1'. Two canonical decimal public signals bind the exact Poseidon task hash and escrow UUID. Never include the private preimage. This proves preimage knowledge, not arbitrary task completion.",
        },
        payout_invoice: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description:
            "Worker-signed BOLT11 payout invoice. Automated payouts remain disabled pending separately reviewed fee-capped payout integration. Omit this field for proof receipt settlement.",
        },
      },
      required: ["escrow_id", "execution_trace"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

export function clearingController(options: {
  store: ClearingContracts;
  settlementRouter: SettlementRouter;
  secret?: string;
  coreTools: readonly unknown[];
}): RequestHandler {
  return async (req, res, next) => {
    const body = req.body;
    // Express use("/mcp") strips the mount; all(/^\/mcp/) does not.
    const atMcpRoot = req.path === "/" || /^\/mcp\/?$/.test(req.path);
    if (body?.method === "tools/list" && atMcpRoot) {
      // The original signed core manifest remains sealed. Clearing is a separate
      // extension catalog, registered only by hosts explicitly mounting it.
      res.set("Cache-Control", "no-store").json({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [...options.coreTools, ...clearingToolDefinitions] },
      });
      return;
    }
    if (
      body?.method !== "tools/call" ||
      !clearingToolDefinitions.some((tool) => tool.name === body.params?.name)
    ) {
      next();
      return;
    }
    res.set("Cache-Control", "no-store");
    const fail = (status: number, code: string, extra = {}) => {
      res.status(status).json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: {
          code: status === 400 ? -32602 : -32000,
          message: code,
          data: extra,
        },
      });
    };
    if (!atMcpRoot || body.params.task !== undefined) {
      fail(400, "CLEARING_REQUIRES_DIRECT_SYNCHRONOUS_MCP");
      return;
    }
    if (
      body.id === undefined ||
      body.id === null ||
      !["string", "number"].includes(typeof body.id)
    ) {
      fail(400, "CLEARING_REQUEST_ID_REQUIRED");
      return;
    }
    const signer = verifyRequestNip98Signer(req, Date.now());
    if (!signer.provided || !signer.pubkey) {
      fail(401, "NIP98_AUTHENTICATION_REQUIRED");
      return;
    }
    const buyer = signer.pubkey;
    const creating = body.params.name === "clearing.create_contract";
    const parsed = (creating ? createInput : settleInput).safeParse(
      body.params.arguments,
    );
    if (!parsed.success) {
      fail(400, "CLEARING_INVALID_ARGUMENTS");
      return;
    }
    try {
      const keys = activeClearingKeys();
      if (await req.app.locals.swarmReferralRevoked?.(buyer)) {
        fail(403, "CLEARING_IDENTITY_REVOKED");
        return;
      }
      if (!creating) {
        const input = settleInput.parse(parsed.data);
        const contract = await options.store.get(input.escrow_id);
        // Do not disclose another worker's private contract or its existence.
        if (!contract || contract.worker_pubkey !== buyer) {
          fail(403, "CLEARING_WORKER_NOT_AUTHORIZED");
          return;
        }
        if (input.payout_invoice !== undefined) {
          // Always throws, before any LND configuration, estimate, reservation
          // or send. Development mode and new key files cannot bypass this.
          await settleClearingContractPayout(
            contract,
            input.execution_trace,
            input.payout_invoice,
          );
          return;
        }
        if (!keys) {
          fail(503, "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE", {
            escrow_id: contract.escrow_id,
            status: contract.status,
            settlement_available: false,
            zk_receipt_issued: false,
          });
          return;
        }
        const proofDigest = await verifyClearingExecution(
          contract,
          input.execution_trace,
          keys,
        );
        if (!proofDigest) {
          fail(400, "CLEARING_INVALID_EXECUTION_PROOF");
          return;
        }
        const sendReceipt = (stored: ClearingContract) => {
          if (!stored.settlement_receipt)
            throw new Error("Receipt unavailable");
          const result = {
            escrow_id: stored.escrow_id,
            status: "settled",
            development_only: keys.developmentOnly,
            payout_executed: false,
            funding_verified: true,
            receipt: JSON.parse(stored.settlement_receipt),
          };
          res.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            },
          });
        };
        if (contract.status === "settled") {
          if (
            contract.proof_digest !== proofDigest ||
            !contract.settlement_receipt
          ) {
            fail(409, "CLEARING_SETTLEMENT_CONFLICT");
            return;
          }
          sendReceipt(contract);
          return;
        }
        if (
          contract.status !== "pending" ||
          !contract.invoice ||
          !contract.payment_hash ||
          !contract.provider ||
          !contract.macaroon ||
          !contract.expires_at
        ) {
          fail(409, "CLEARING_CONTRACT_NOT_FUNDABLE");
          return;
        }
        const amountMsats = Number(contract.amount_sats) * 1000;
        if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0) {
          fail(409, "CLEARING_INVALID_CONTRACT_AMOUNT");
          return;
        }
        // Values come ONLY from the server's immutable invoice reservation,
        // never a worker's payment assertion or a replacement invoice.
        const funding = await options.settlementRouter.verifyPayment({
          paymentHash: contract.payment_hash,
          preimage: "",
          verificationMode: "merchant-lookup",
          expectedAmountMsats: amountMsats,
          expectedDescription: `A2A clearing ${contract.escrow_id} task ${contract.task_hash}`,
          expectedProvider: contract.provider,
          asset: "btc-lightning",
        });
        if (funding === "unavailable") {
          fail(503, "CLEARING_FUNDING_VERIFICATION_UNAVAILABLE");
          return;
        }
        if (
          funding === "invalid" ||
          funding.provider !== contract.provider ||
          funding.asset !== "btc-lightning" ||
          !Number.isSafeInteger(funding.settledAt) ||
          funding.settledAt <= 0
        ) {
          fail(409, "CLEARING_FUNDING_NOT_CONFIRMED");
          return;
        }
        const signed = signClearingReceipt(
          contract,
          proofDigest,
          funding.settledAt,
          keys,
        );
        // Recheck the gate immediately before the only settlement write.
        if (activeClearingKeys() !== keys) {
          fail(503, "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE");
          return;
        }
        const settled = await options.store.settleVerified(
          contract,
          proofDigest,
          signed.receipt,
          signed.settledAt,
        );
        if (!settled) {
          fail(409, "CLEARING_SETTLEMENT_CONFLICT");
          return;
        }
        sendReceipt(settled);
        return;
      }
      if (
        !options.secret ||
        !options.settlementRouter.isConfigured("btc-lightning")
      ) {
        fail(503, "CLEARING_FUNDING_UNAVAILABLE");
        return;
      }
      if (keys && !keys.developmentOnly) {
        const task = createInput.parse(parsed.data).task_hash;
        const scalarField =
          21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        if (BigInt(`0x${task}`) >= scalarField) {
          fail(400, "CLEARING_UNSUPPORTED_TASK_HASH");
          return;
        }
      }
      const input = createInput.parse(parsed.data);
      const requestDigest = createHash("sha256")
        .update(buyer)
        .update("\n")
        .update(requestNip98Payload(req) ?? new Uint8Array())
        .digest("hex");
      const reserved = await options.store.reserve({
        ...input,
        buyer_pubkey: buyer,
        request_digest: requestDigest,
      });
      let contract: ClearingContract = reserved.contract;
      if (reserved.inserted) {
        // Persist the intent BEFORE wallet I/O. Ambiguous invoice failures never
        // automatically request a replacement for this same request.
        const expirySeconds = 900;
        const expiresAt = new Date(Date.now() + expirySeconds * 1000);
        const invoice = await options.settlementRouter.createInvoice({
          amountMsats: input.amount_sats * 1000,
          expirySeconds,
          asset: "btc-lightning",
          description: `A2A clearing ${contract.escrow_id} task ${input.task_hash}`,
        });
        if (
          !invoice.invoice.startsWith("ln") ||
          !/^[0-9a-f]{64}$/.test(invoice.paymentHash) ||
          !/^[a-z0-9][a-z0-9-]{0,63}$/.test(invoice.provider)
        ) {
          throw new Error("Invalid clearing invoice");
        }
        // A different root key AND RPC caveat prevent use as a paid core pass.
        const secret = createHmac("sha256", options.secret)
          .update("clearing/v1")
          .digest("hex");
        const macaroon = attenuateSubscriptionMacaroon(
          createSubscriptionMacaroon({
            secret,
            paymentHash: invoice.paymentHash,
            tier: "1-day",
            validUntil: Math.floor(expiresAt.getTime() / 1000),
            amountMsats: input.amount_sats * 1000,
            paymentAsset: "btc-lightning",
            paymentProvider: invoice.provider,
            agentId: buyer,
            agentAuthentication: "nip98",
          }),
          ["rpc = clearing.settle_contract"],
        );
        if (!macaroon) throw new Error("Clearing capability unavailable");
        contract = await options.store.attachInvoice(contract.escrow_id, {
          ...invoice,
          macaroon,
          expiresAt,
        });
      }
      if (
        !contract.invoice ||
        !contract.macaroon ||
        !contract.expires_at ||
        contract.expires_at.getTime() <= Date.now()
      ) {
        fail(503, "CLEARING_INVOICE_PENDING_OR_EXPIRED", {
          escrow_id: contract.escrow_id,
        });
        return;
      }
      const result = {
        escrow_id: contract.escrow_id,
        status: "pending",
        invoice: contract.invoice,
        macaroon: contract.macaroon,
        payment_hash: contract.payment_hash,
        amount_sats: Number(contract.amount_sats),
        expires_at: contract.expires_at.toISOString(),
        funding_verified: false,
        settlement_available: Boolean(keys),
        execution_scheme: keys?.scheme ?? null,
        verification_key_id: keys?.verificationKeyId ?? null,
        payout_available: false,
        warning: !keys
          ? "Local settlement is disabled. Do not fund."
          : keys.developmentOnly
            ? "Local development only. Preimage knowledge is not arbitrary task execution. No payout is implemented. Do not fund with real sats."
            : "Genesis proof receipt settlement is enabled. This proves preimage knowledge, not task completion. No automated payout or refund is enabled; funds remain merchant-controlled.",
      };
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    } catch (error) {
      if (
        error instanceof LndPayoutError &&
        error.code === CLEARING_PAYOUT_DISABLED
      ) {
        fail(503, CLEARING_PAYOUT_DISABLED, {
          settlement_available: false,
          payout_executed: false,
          zk_receipt_issued: false,
        });
        return;
      }
      // Provider/SQL diagnostics can contain credentials. Never reflect them.
      fail(503, "CLEARING_STORAGE_OR_PROVIDER_UNAVAILABLE");
    }
  };
}
