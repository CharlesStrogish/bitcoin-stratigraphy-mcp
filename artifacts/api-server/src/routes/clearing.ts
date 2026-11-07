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
    // Opaque until a purpose-built circuit and trusted public-signal layout exist.
    execution_trace: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export const clearingToolDefinitions = [
  {
    name: "clearing.create_contract",
    description:
      "Scaffold: reserve a private A2A contract and issue its funding invoice. Buyer comes only from fresh NIP-98 authentication. Settlement is DISABLED: do not fund until a trusted execution circuit is deployed. An unpaid invoice is not locked funds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        worker_pubkey: { type: "string", pattern: "^[0-9a-f]{64}$" },
        task_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        amount_sats: {
          type: "integer",
          minimum: 1,
          maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1000),
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
      "Fail-closed A2A settlement scaffold. Authenticates the exact worker and reads its PostgreSQL contract, but NEVER marks it settled or issues a ZK-Indemnity Receipt: no trusted execution Groth16 circuit is configured.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        escrow_id: { type: "string", format: "uuid" },
        execution_trace: { type: "string", minLength: 1, maxLength: 65536 },
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
        // No telemetry/drift proof, digest comparison, or mock verification can
        // substitute for an execution circuit. No settlement writes or payout.
        fail(503, "CLEARING_EXECUTION_VERIFIER_UNAVAILABLE", {
          escrow_id: contract.escrow_id,
          status: contract.status,
          settlement_available: false,
          zk_receipt_issued: false,
        });
        return;
      }
      if (
        !options.secret ||
        !options.settlementRouter.isConfigured("btc-lightning")
      ) {
        fail(503, "CLEARING_FUNDING_UNAVAILABLE");
        return;
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
        settlement_available: false,
        warning: "Settlement is disabled. Do not fund this scaffold.",
      };
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        },
      });
    } catch {
      // Provider/SQL diagnostics can contain credentials. Never reflect them.
      fail(503, "CLEARING_STORAGE_OR_PROVIDER_UNAVAILABLE");
    }
  };
}
