import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  buildHttp402NextAction,
  withX402NextActionAlternative,
} from "../../src/lib/http402-next-action";
import { createL402Middleware } from "../../src/middleware/l402";
import { createX402PaymentMiddleware } from "../../src/middleware/payment";
import { frameMcpErrors } from "../../src/middleware/mcpJsonRpc";
import type { SettlementRouter } from "../../src/services/settlement";
import { assertNextAction } from "../../src/lib/testing/next-action";
import {
  CloseEnterpriseCreditTabResponse,
  ExecuteMcpRequestResponse,
} from "@workspace/api-zod";
import { openApiDocument } from "../../src/openapi";

const input = {
  reason: "toll_required" as const,
  invoice: "lnbc1challenge",
  payment_hash: createHash("sha256").update("challenge").digest("hex"),
  macaroon: "challenge-scoped-capability",
  method: "POST",
  path: "/paid?range=1",
};

test("builder is deterministic, omits undefined, and copies only allowlisted challenge fields", () => {
  const supplied = {
    ...input,
    amount_sats: undefined,
    secret: "must-not-copy",
  };
  const result = buildHttp402NextAction(supplied);
  assert.equal(
    JSON.stringify(result),
    JSON.stringify(buildHttp402NextAction(supplied)),
  );
  assert.equal(Object.hasOwn(result.payment, "amount_sats"), false);
  assert.equal(Object.hasOwn(result, "alternatives"), false);
  assert.equal(JSON.stringify(result).includes("must-not-copy"), false);
  assertNextAction(
    { ...input, next_action: result },
    "toll_required",
    "POST",
    input.path,
  );
  assert.equal(
    buildHttp402NextAction({ ...input, amount_sats: 1.125 }).payment
      .amount_sats,
    1.125,
  );
  assert.deepEqual(supplied, {
    ...input,
    amount_sats: undefined,
    secret: "must-not-copy",
  });
});

test("x402 enrichment is additive, idempotent and supports already-framed strict errors", () => {
  const body = {
    ...input,
    next_action: buildHttp402NextAction(input),
    legacy: { preserve: true },
  };
  const original = JSON.stringify(body);
  const enriched = withX402NextActionAlternative(body) as typeof body;
  assert.equal(JSON.stringify(body), original);
  assert.deepEqual({ ...enriched, next_action: body.next_action }, body);
  assert.deepEqual(withX402NextActionAlternative(enriched), enriched);
  const framed = {
    jsonrpc: "2.0",
    id: 7,
    error: { code: 402, message: "Payment", data: body },
  };
  const result = withX402NextActionAlternative(framed) as typeof framed;
  assert.deepEqual(Object.keys(result).sort(), ["error", "id", "jsonrpc"]);
  assert.deepEqual(result.error.data, enriched);
  for (const value of [undefined, null, [], "error", { error: "unrelated" }])
    assert.deepEqual(withX402NextActionAlternative(value), value);
});

// Synthetic invoice creation only: no real wallet, payment or credentials.
for (const framing of ["rest", "handshake", "stateless"] as const) {
  for (const x402 of [false, true]) {
    for (const requestPath of ["/paid?range=1", "/invoice/request"]) {
      test(`${framing} ${requestPath} keeps legacy bytes and binds x402 only to its emitted header (${x402})`, async () => {
        const app = express();
        app.use(express.json());
        if (framing !== "rest") {
          app.use((_req, res, next) => {
            if (framing === "stateless")
              res.locals.mcpProtocol = {
                era: "stateless",
                version: "2026-07-28",
              };
            next();
          });
          app.use(frameMcpErrors);
        }
        if (x402) app.use(createX402PaymentMiddleware({}));
        const router: SettlementRouter = {
          isConfigured: () => true,
          activeProvider: () => "fixture",
          circuitState: () => "closed",
          createInvoice: async () => ({
            invoice: input.invoice,
            paymentHash: input.payment_hash,
            provider: "fixture",
          }),
          verifyPayment: async () => "invalid",
        };
        app.post(
          ["/paid", "/invoice/request"],
          createL402Middleware({
            amountSats: 5,
            fixedUnitPrice: true,
            sessionSecret: "synthetic-next-action-test-only",
            description: "synthetic invoice",
            settlementRouter: router,
          }),
        );
        const server = app.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const response = await fetch(
            `http://127.0.0.1:${(server.address() as AddressInfo).port}${requestPath}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 7,
                method: "tools/call",
              }),
            },
          );
          assert.equal(response.status, 402);
          const payload = await response.json();
          const body = framing === "stateless" ? payload.error.data : payload;
          assertNextAction(
            body,
            "toll_required",
            "POST",
            requestPath === "/invoice/request" ? "/mcp" : requestPath,
          );
          assert.equal(
            response.headers.get("www-authenticate"),
            `L402 macaroon="${body.macaroon}", invoice="${body.invoice}"`,
          );
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.equal(response.headers.has("PAYMENT-REQUIRED"), x402);
          assert.equal(
            Boolean(
              body.next_action.alternatives?.some(
                (a: { protocol: string }) => a.protocol === "x402",
              ),
            ),
            x402,
          );
          assert.equal(body.amount_sats, 5);
          assert.equal(body.dynamic_fee_sats, 5);
          assert.equal(body.payment_hash, input.payment_hash);
          assert.equal(body.invoice, input.invoice);
          assert.ok(body.licensing_compliance);
          assert.ok(body.payment_bridge_instructions);
          if (framing === "stateless") {
            assert.deepEqual(Object.keys(payload).sort(), [
              "error",
              "id",
              "jsonrpc",
            ]);
            assert.equal(payload.error.code, 402);
          } else if (framing === "handshake") {
            assert.equal(payload.error.code, -32002);
            assert.equal(payload.jsonrpc, "2.0");
            assert.equal(payload.id, 7);
          }
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
          );
        }
      });
    }
  }
}

for (const excluded of [false, true]) {
  test(`x402 ${excluded ? "credit-tab exclusion" : "quote failure"} leaves challenge and headers untouched`, async () => {
    const app = express();
    const body = {
      ...input,
      next_action: buildHttp402NextAction(input),
      legacy: "preserved",
    };
    let quoteCalls = 0;
    app.use((_req, res, next) => {
      res.locals.creditTabSettlement = excluded;
      next();
    });
    app.use(
      createX402PaymentMiddleware({
        resourceServer: {
          createPaymentRequiredResponse: async () => {
            quoteCalls++;
            throw new Error("synthetic quote failure");
          },
          settlePayment: async () => {
            throw new Error("must not settle");
          },
        },
      }),
    );
    app.get("/paid", (_req, res) => {
      res.setHeader(
        "WWW-Authenticate",
        'L402 macaroon="unchanged", invoice="unchanged"',
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(402).json(body);
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/paid`,
      );
      assert.equal(response.status, 402);
      assert.deepEqual(await response.json(), body);
      assert.equal(response.headers.has("PAYMENT-REQUIRED"), false);
      assert.equal(
        response.headers.get("www-authenticate"),
        'L402 macaroon="unchanged", invoice="unchanged"',
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(quoteCalls, excluded ? 0 : 1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
}

test("generated 402 validators retain the formally declared envelope", () => {
  const next_action = buildHttp402NextAction(input);
  const minimal = { next_action, extra_legacy: "untouched" };
  assert.deepEqual(CloseEnterpriseCreditTabResponse.parse(minimal), minimal);
  const spec = openApiDocument as any;
  for (const schema of [
    "L402Challenge",
    "L402PaymentRequired",
    "McpJsonRpcResponse",
  ])
    assert.equal(
      spec.components.schemas[schema].properties.next_action.$ref,
      "#/components/schemas/Http402NextAction",
    );
  assert.equal(
    spec.paths["/fiat-mint"].post.responses["402"].content["application/json"]
      .schema.properties.next_action.$ref,
    "#/components/schemas/Http402NextAction",
  );
  const rpc = {
    jsonrpc: "2.0",
    id: 7,
    error: {
      code: 402,
      message: "Payment",
      data: { next_action, extra: "preserved" },
    },
  };
  assert.deepEqual(ExecuteMcpRequestResponse.parse(rpc), rpc);
  const handshake = {
    ...rpc,
    error: { code: -32002, message: "Payment" },
    next_action,
  };
  assert.deepEqual(ExecuteMcpRequestResponse.parse(handshake), handshake);
});
