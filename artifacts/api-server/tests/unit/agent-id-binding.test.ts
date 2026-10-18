import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  AGENT_ID_HEADER,
  formatAgentIdCaveat,
  parseAgentIdCaveat,
} from "../../src/lib/agent-id-caveat";
import {
  attenuateSubscriptionMacaroon,
  createSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../../src/lib/subscription-pass";
import { createL402Middleware } from "../../src/middleware/l402";
import type { SettlementRouter } from "../../src/services/settlement";

const SECRET = "agent-identity-binding-secret";
const PREIMAGE = "0a".repeat(32);
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex");
const ISSUED_AT = Date.parse("2026-10-18T12:00:00.000Z");
const DESCRIPTION = "Agent attribution test execution";
const ROUTE = "/api/v1/attributed";

type Token = { identifier: string; caveats: string[]; signature: string };
const decode = (macaroon: string) =>
  JSON.parse(Buffer.from(macaroon, "base64url").toString("utf8")) as Token;
const encode = (token: Token) =>
  Buffer.from(JSON.stringify(token)).toString("base64url");

/** Appends raw caveat bytes exactly as any holder can, skipping attenuation checks. */
function appendRawCaveat(macaroon: string, caveat: string): string {
  const token = decode(macaroon);
  return encode({
    identifier: token.identifier,
    caveats: [...token.caveats, caveat],
    signature: createHmac("sha256", Buffer.from(token.signature, "hex"))
      .update(caveat)
      .digest("hex"),
  });
}

/** One gated route with a counting wallet; the handler echoes the verified locals. */
async function startGatedServer() {
  const calls = { invoices: 0, verifications: 0, executions: 0 };
  const settlementRouter: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "test-wallet",
    circuitState: () => "closed",
    async createInvoice() {
      calls.invoices += 1;
      return {
        invoice: `lnbc5n1agent${calls.invoices}`,
        paymentHash: PAYMENT_HASH,
        provider: "test-wallet",
      };
    },
    async verifyPayment(input) {
      calls.verifications += 1;
      return input.paymentHash === PAYMENT_HASH &&
        input.preimage === PREIMAGE &&
        input.expectedAmountMsats === 5_000 &&
        input.expectedDescription === DESCRIPTION &&
        input.expectedProvider === "test-wallet"
        ? { settledAt: Math.floor(ISSUED_AT / 1_000), provider: "test-wallet" }
        : "invalid";
    },
  };
  const app = express();
  app.use(express.json());
  app.post(
    ROUTE,
    createL402Middleware({
      amountSats: 5,
      description: DESCRIPTION,
      settlementRouter,
      sessionSecret: SECRET,
      now: () => ISSUED_AT,
      // Refused credentials are not re-challenged, but keep every attempt observable.
      maxChallengesPerMinute: 100,
    }),
    (_req, res) => {
      calls.executions += 1;
      res.json({ l402: res.locals.l402 });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ROUTE}`;
  const post = async (
    options: { macaroon?: string; header?: string; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.macaroon)
      headers.Authorization = `L402 ${options.macaroon}:${PREIMAGE}`;
    if (options.header !== undefined) headers[AGENT_ID_HEADER] = options.header;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return {
    calls,
    post,
    /** Credential from a real 402 challenge, optionally declaring an agent. */
    async issue(declaration: { header?: string; body?: unknown } = {}) {
      const challenge = await post(declaration);
      assert.equal(challenge.status, 402);
      return challenge.body as { macaroon: string; agent_id?: string };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("encodes exactly one canonical agent_id caveat and refuses every variant", () => {
  assert.equal(formatAgentIdCaveat("planner-7"), "agent_id = planner-7");
  assert.equal(parseAgentIdCaveat("agent_id = planner-7"), "planner-7");
  const longest = `a${"b".repeat(127)}`;
  assert.equal(parseAgentIdCaveat(formatAgentIdCaveat(longest)), longest);
  assert.equal(
    parseAgentIdCaveat("agent_id = org:acme/swarm@v2#worker-3"),
    "org:acme/swarm@v2#worker-3",
  );
  for (const variant of [
    "agent_id=planner-7",
    "agent_id =planner-7",
    "agent_id= planner-7",
    "agent_id  = planner-7",
    " agent_id = planner-7",
    "agent_id = planner-7 ",
    "AGENT_ID = planner-7",
    "agent_id = ",
    "agent_id = -planner",
    "agent_id = planner 7",
    "agent_id = planner\n7",
    `agent_id = a${"b".repeat(128)}`,
  ]) {
    assert.equal(parseAgentIdCaveat(variant), null, variant);
  }
  for (const invalid of [
    "",
    " planner",
    "planner 7",
    "-lead",
    `a${"b".repeat(128)}`,
  ]) {
    assert.throws(() => formatAgentIdCaveat(invalid), RangeError, invalid);
  }
});

test("a declared agent is HMAC-bound into the challenge macaroon", async () => {
  const gate = await startGatedServer();
  try {
    const byHeader = await gate.issue({ header: "planner-7" });
    assert.equal(byHeader.agent_id, "planner-7");
    const caveats = decode(byHeader.macaroon).caveats;
    assert.deepEqual(
      caveats.filter((caveat) => caveat.startsWith("agent_id")),
      ["agent_id = planner-7"],
    );
    // Issuer-bound in the root, before the per-route delegation scope.
    assert.ok(
      caveats.indexOf("agent_id = planner-7") <
        caveats.findIndex((caveat) => caveat.startsWith("allowed_path=")),
    );
    const pass = verifySubscriptionMacaroon(
      byHeader.macaroon,
      SECRET,
      ISSUED_AT / 1_000,
    );
    assert.equal(pass?.agentId, "planner-7");

    const byBody = await gate.issue({ body: { agent_id: "auditor.eu-12" } });
    assert.equal(byBody.agent_id, "auditor.eu-12");
    assert.equal(
      verifySubscriptionMacaroon(byBody.macaroon, SECRET, ISSUED_AT / 1_000)
        ?.agentId,
      "auditor.eu-12",
    );

    const unbound = await gate.issue();
    assert.equal(Object.hasOwn(unbound, "agent_id"), false);
    assert.ok(
      !decode(unbound.macaroon).caveats.some((caveat) =>
        caveat.startsWith("agent_id"),
      ),
    );
    const unboundPass = verifySubscriptionMacaroon(
      unbound.macaroon,
      SECRET,
      ISSUED_AT / 1_000,
    );
    assert.ok(unboundPass);
    assert.equal(Object.hasOwn(unboundPass, "agentId"), false);
    assert.equal(gate.calls.verifications, 0);
  } finally {
    await gate.close();
  }
});

test("tampered, duplicated or forged agent caveats never verify", () => {
  const root = createSubscriptionMacaroon({
    secret: SECRET,
    paymentHash: PAYMENT_HASH,
    tier: "1-day",
    validUntil: ISSUED_AT / 1_000 + 600,
    amountMsats: 5_000,
    agentId: "planner-7",
  });
  const now = ISSUED_AT / 1_000;
  assert.equal(
    verifySubscriptionMacaroon(root, SECRET, now)?.agentId,
    "planner-7",
  );

  // Rewriting the bound ID breaks the HMAC chain.
  const token = decode(root);
  const rewritten = encode({
    ...token,
    caveats: token.caveats.map((caveat) =>
      caveat === "agent_id = planner-7" ? "agent_id = planner-8" : caveat,
    ),
  });
  assert.equal(verifySubscriptionMacaroon(rewritten, SECRET, now), null);
  // A holder cannot rebind: a second agent caveat invalidates the credential.
  assert.equal(
    verifySubscriptionMacaroon(
      appendRawCaveat(root, "agent_id = planner-8"),
      SECRET,
      now,
    ),
    null,
  );
  assert.equal(
    verifySubscriptionMacaroon(
      appendRawCaveat(root, "agent_id = planner-7"),
      SECRET,
      now,
    ),
    null,
  );
  // Non-canonical spellings are unknown caveats and fail closed.
  assert.equal(
    verifySubscriptionMacaroon(
      appendRawCaveat(root, "agent_id=planner-7"),
      SECRET,
      now,
    ),
    null,
  );
  // Server attenuation accepts delegation caveats only.
  assert.equal(
    attenuateSubscriptionMacaroon(root, ["agent_id = planner-8"]),
    null,
  );
  // A different signing secret never verifies the binding.
  assert.equal(verifySubscriptionMacaroon(root, "another-secret", now), null);
  assert.throws(
    () =>
      createSubscriptionMacaroon({
        secret: SECRET,
        paymentHash: PAYMENT_HASH,
        tier: "1-day",
        validUntil: now + 600,
        agentId: "planner 7",
      }),
    RangeError,
  );
});

test("the middleware enforces the binding before any wallet, quota or handler work", async () => {
  const gate = await startGatedServer();
  try {
    const { macaroon } = await gate.issue({ header: "planner-7" });
    const invoices = gate.calls.invoices;

    const missing = await gate.post({ macaroon });
    assert.equal(missing.status, 403);
    assert.match(String(missing.body.error), /bound to an agent_id/);
    const mismatched = await gate.post({ macaroon, header: "planner-8" });
    assert.equal(mismatched.status, 403);
    assert.match(String(mismatched.body.error), /does not match/);
    const mismatchedBody = await gate.post({
      macaroon,
      body: { agent_id: "planner-8" },
    });
    assert.equal(mismatchedBody.status, 403);
    assert.equal(gate.calls.verifications, 0);
    assert.equal(gate.calls.executions, 0);
    assert.equal(
      gate.calls.invoices,
      invoices,
      "refusals never mint a new invoice",
    );

    // The refusals consumed nothing: the single-use credential still redeems,
    // and the handler receives the verified agent from the caveat.
    const accepted = await gate.post({ macaroon, header: "planner-7" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body.l402, {
      paymentHash: PAYMENT_HASH,
      settledAt: Math.floor(ISSUED_AT / 1_000),
      provider: "test-wallet",
      agentId: "planner-7",
    });
    assert.equal(gate.calls.verifications, 1);
    assert.equal(gate.calls.executions, 1);

    const bodyBound = await gate.issue({ body: { agent_id: "auditor.eu-12" } });
    const viaBody = await gate.post({
      macaroon: bodyBound.macaroon,
      header: "auditor.eu-12",
      body: { agent_id: "auditor.eu-12" },
    });
    assert.equal(viaBody.status, 200);
    assert.equal(
      (viaBody.body.l402 as { agentId?: string }).agentId,
      "auditor.eu-12",
    );
  } finally {
    await gate.close();
  }
});

test("undeclared credentials stay unattributed and refuse late declarations", async () => {
  const gate = await startGatedServer();
  try {
    const { macaroon } = await gate.issue();
    const late = await gate.post({ macaroon, header: "planner-7" });
    assert.equal(late.status, 403);
    assert.match(String(late.body.error), /no agent_id caveat/);
    assert.equal(gate.calls.verifications, 0);

    const accepted = await gate.post({ macaroon });
    assert.equal(accepted.status, 200);
    const locals = accepted.body.l402 as Record<string, unknown>;
    assert.equal(Object.hasOwn(locals, "agentId"), false);
  } finally {
    await gate.close();
  }
});

test("a holder may delegate an unbound credential to one sub-agent without new uses", async () => {
  const gate = await startGatedServer();
  try {
    const { macaroon } = await gate.issue();
    const delegated = appendRawCaveat(macaroon, "agent_id = worker-3");
    assert.equal((await gate.post({ macaroon: delegated })).status, 403);
    const redeemed = await gate.post({
      macaroon: delegated,
      header: "worker-3",
    });
    assert.equal(redeemed.status, 200);
    assert.equal(
      (redeemed.body.l402 as { agentId?: string }).agentId,
      "worker-3",
    );
    // The delegated child spent the parent's single use.
    assert.equal((await gate.post({ macaroon })).status, 429);
    assert.equal(gate.calls.executions, 1);
  } finally {
    await gate.close();
  }
});

test("malformed or conflicting declarations are rejected before a challenge", async () => {
  const gate = await startGatedServer();
  try {
    for (const declaration of [
      { header: "" },
      { header: "planner 7" },
      { header: `a${"b".repeat(128)}` },
      { body: { agent_id: 7 } },
      { body: { agent_id: "" } },
      { body: { agent_id: null } },
      { header: "planner-7", body: { agent_id: "planner-8" } },
    ]) {
      const response = await gate.post(declaration);
      assert.equal(response.status, 400, JSON.stringify(declaration));
      assert.match(String(response.body.error), /agent_id|X-Agent-Id/);
    }
    assert.equal(gate.calls.invoices, 0);
    assert.equal(gate.calls.verifications, 0);
  } finally {
    await gate.close();
  }
});
