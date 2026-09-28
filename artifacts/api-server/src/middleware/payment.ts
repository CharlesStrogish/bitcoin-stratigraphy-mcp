import type { RequestHandler, Request } from "express";
import {
  x402ResourceServer,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";

export const X402_NETWORK: PaymentRequirements["network"] = "eip155:8453";
export const X402_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const X402_PAY_TO = "0x7a4183ce5b9989833bb33133dcbb8efd6a84e775";
export const X402_AMOUNT = "1000";

export type X402ResourceServerLike = Pick<
  x402ResourceServer,
  "createPaymentRequiredResponse" | "settlePayment"
>;

export type X402MiddlewareOptions = {
  resourceServer: X402ResourceServerLike;
  amount?: string;
  payTo?: string;
  asset?: string;
  network?: PaymentRequirements["network"];
};

export function isCdpX402Configured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.CDP_API_KEY_ID?.trim() && env.CDP_API_KEY_SECRET?.trim());
}

export async function createCdpX402ResourceServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<x402ResourceServer | undefined> {
  if (!isCdpX402Configured(env)) return undefined;
  // Load the SDK's facilitator module directly so its optional SVM and x402
  // extension peers are not required just to use the EVM facilitator.
  const x402EntryUrl = import.meta.resolve("@coinbase/cdp-sdk/x402");
  const facilitatorModuleUrl = new URL("./facilitator.js", x402EntryUrl).href;
  const { createCdpFacilitatorClient } = await import(facilitatorModuleUrl);
  const server = new x402ResourceServer(
    createCdpFacilitatorClient({
      apiKeyId: env.CDP_API_KEY_ID,
      apiKeySecret: env.CDP_API_KEY_SECRET,
    }),
  );
  server.register(X402_NETWORK, new ExactEvmScheme());
  // Do not advertise x402 until the facilitator confirms it supports Base exact.
  await server.initialize();
  if (!server.getSupportedKind(2, X402_NETWORK, "exact")) {
    throw new Error("CDP facilitator does not support x402 v2 exact on Base");
  }
  return server;
}

function requestResourceUrl(req: Request): string {
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function decodePaymentSignature(header: string): PaymentPayload | null {
  try {
    const decoded = Buffer.from(header.trim(), "base64").toString("utf8");
    const payload: unknown = JSON.parse(decoded);
    if (
      payload === null ||
      typeof payload !== "object" ||
      (payload as { x402Version?: unknown }).x402Version !== 2 ||
      !("accepted" in payload) ||
      !("payload" in payload)
    ) return null;
    return payload as PaymentPayload;
  } catch {
    return null;
  }
}

function exactTerms(
  offered: unknown,
  expected: PaymentRequirements,
): boolean {
  if (offered === null || typeof offered !== "object") return false;
  const candidate = offered as Partial<PaymentRequirements>;
  const extra = candidate.extra;
  return candidate.scheme === "exact" &&
    candidate.network === expected.network &&
    typeof candidate.asset === "string" &&
    candidate.asset.toLowerCase() === expected.asset.toLowerCase() &&
    candidate.amount === expected.amount &&
    typeof candidate.payTo === "string" &&
    candidate.payTo.toLowerCase() === expected.payTo.toLowerCase() &&
    candidate.maxTimeoutSeconds === expected.maxTimeoutSeconds &&
    extra?.paymentFlow === "upfront" &&
    extra.name === "USD Coin" &&
    extra.version === "2";
}

export function createX402PaymentMiddleware(
  options: X402MiddlewareOptions,
): RequestHandler {
  const expected: PaymentRequirements = {
    scheme: "exact",
    network: options.network ?? X402_NETWORK,
    asset: options.asset ?? X402_ASSET,
    amount: options.amount ?? X402_AMOUNT,
    payTo: options.payTo ?? X402_PAY_TO,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USD Coin",
      version: "2",
      paymentFlow: "upfront",
    },
  };

  const createChallengeHeader = async (req: Request): Promise<string> => {
    const resourceUrl = requestResourceUrl(req);
    const response = await options.resourceServer.createPaymentRequiredResponse(
      [expected],
      { url: resourceUrl, description: "MCP tool call payment" },
    );
    return Buffer.from(JSON.stringify(response)).toString("base64");
  };

  return async (req, res, next) => {
    const signature = req.header("PAYMENT-SIGNATURE");
    if (!signature) {
      // Preserve the existing L402 response and add x402 only when its authenticated
      // settlement path is configured and the L402 gate actually challenges.
      if (!res.locals.x402ChallengeEnabled) {
        next();
        return;
      }
      const sendJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode !== 402) return sendJson(body);
        void createChallengeHeader(req)
          .then((challenge) => {
            res.setHeader("PAYMENT-REQUIRED", challenge);
            sendJson(body);
          })
          .catch((error: unknown) => {
            req.log?.error({ err: error }, "Unable to create x402 payment challenge");
            sendJson(body);
          });
        return res;
      }) as typeof res.json;
      next();
      return;
    }

    const payload = decodePaymentSignature(signature);
    const resourceUrl = requestResourceUrl(req);
    if (!payload || payload.resource?.url !== resourceUrl ||
        !exactTerms(payload.accepted, expected)) {
      res.status(400).json({ error: "Invalid x402 payment signature or payment terms" });
      return;
    }

    try {
      // The upfront flow intentionally uses /settle as the validation and commit
      // operation. Calling verifyPayment here would introduce a separate /verify
      // request and would not prove that this authorization was committed on-chain.
      const settlement = await options.resourceServer.settlePayment(
        payload,
        expected,
        undefined,
        { url: resourceUrl },
        undefined,
        "before-handler",
      );
      if (
        settlement.success !== true ||
        !settlement.transaction ||
        settlement.network !== expected.network ||
        (settlement.amount !== undefined && settlement.amount !== expected.amount)
      ) {
        res.status(502).json({ error: "x402 payment settlement failed" });
        return;
      }
      res.locals.x402 = {
        network: settlement.network,
        transaction: settlement.transaction,
        amount: settlement.amount,
      };
      next();
    } catch (error) {
      req.log?.error({ err: error }, "x402 verification or settlement failed");
      res.status(502).json({ error: "Unable to verify or settle x402 payment" });
    }
  };
}