import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  formatRpcCaveat,
  formatTimeCaveat,
  parseDelegationCaveat,
} from "../../src/lib/delegation-caveats";
import {
  attenuateSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../../src/lib/subscription-pass";
import { createL402Middleware } from "../../src/middleware/l402";
import type { SettlementRouter } from "../../src/services/settlement";

const SECRET = "hyper-granular-caveat-secret";
const PREIMAGE = "07".repeat(32);
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex");
const ISSUED_AT = Date.parse("2026-10-17T12:00:00.000Z");
const DESCRIPTION = "Caveat enforcement test execution";
const GET_DIFF = "/mcp/tools/stratigraphy.get_diff";
const GET_DIGEST = "/mcp/tools/stratigraphy.get_digest";

/** Appends raw caveat bytes exactly as any holder can, skipping attenuation checks. */
function appendRawCaveat(macaroon: string, caveat: string): string {
  const token = JSON.parse(
    Buffer.from(macaroon, "base64url").toString("utf8"),
  ) as { identifier: string; caveats: string[]; signature: string };
  return Buffer.from(
    JSON.stringify({
      identifier: token.identifier,
      caveats: [...token.caveats, caveat],
      signature: createHmac("sha256", Buffer.from(token.signature, "hex"))
        .update(caveat)
        .digest("hex"),
    }),
  ).toString("base64url");
}

/** Two MCP tool gates and one REST gate sharing a controllable clock and wallet. */
async function startGatedServer() {
  const clock = { now: ISSUED_AT };
  const calls = { invoices: 0, verifications: 0, executions: [] as string[] };
  const settlementRouter: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "test-wallet",
    circuitState: () => "closed",
    async createInvoice() {
      calls.invoices += 1;
      return {
        invoice: `lnbc5n1caveat${calls.invoices}`,
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
        ? { settledAt: Math.floor(clock.now / 1_000), provider: "test-wallet" }
        : "invalid";
    },
  };
  const gate = (tool?: string, scopePath?: string) =>
    createL402Middleware({
      amountSats: 5,
      description: DESCRIPTION,
      settlementRouter,
      sessionSecret: SECRET,
      now: () => clock.now,
      // Forged credentials are re-challenged; keep every refusal observable.
      maxChallengesPerMinute: 100,
      ...(scopePath ? { scopePath } : {}),
      ...(tool ? { tool } : {}),
    });
  const app = express();
  for (const tool of ["stratigraphy.get_diff", "stratigraphy.get_digest"]) {
    app.post(
      `/mcp/tools/${tool}`,
      gate(tool, `/mcp/tools/${tool}`),
      (_req, res) => {
        calls.executions.push(tool);
        res.json({ executed: tool });
      },
    );
  }
  app.get("/api/v1/report", gate(), (_req, res) => {
    calls.executions.push("rest");
    res.json({ executed: "rest" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    clock,
    calls,
    /** Root credential from a real 402 challenge, scoped to one tool path. */
    async issue(path = GET_DIFF) {
      const challenge = await fetch(`${baseUrl}${path}`, { method: "POST" });
      assert.equal(challenge.status, 402);
      return ((await challenge.json()) as { macaroon: string }).macaroon;
    },
    async redeem(macaroon: string, path: string) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: path.startsWith("/mcp/") ? "POST" : "GET",
        headers: { Authorization: `L402 ${macaroon}:${PREIMAGE}` },
      });
      return {
        status: response.status,
        challenged: response.headers.has("www-authenticate"),
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("formats canonical time and rpc caveats and refuses anything else", () => {
  const deadline = ISSUED_AT + 60_000;
  assert.equal(formatTimeCaveat(deadline), "time < 2026-10-17T12:01:00.000Z");
  assert.deepEqual(parseDelegationCaveat("time < 2026-10-17T12:01:00.000Z"), {
    type: "time",
    deadline,
  });
  assert.equal(
    formatRpcCaveat(["stratigraphy.get_diff"]),
    "rpc = stratigraphy.get_diff",
  );
  assert.deepEqual(
    parseDelegationCaveat("rpc = stratigraphy.get_diff,proof.verify"),
    { type: "rpc", tools: ["stratigraphy.get_diff", "proof.verify"] },
  );
  for (const invalid of [
    Number.NaN,
    1.5,
    -1e20,
    8.64e15 + 1,
    Date.UTC(10_000, 0, 1),
  ]) {
    assert.throws(() => formatTimeCaveat(invalid), RangeError, String(invalid));
  }
  for (const invalid of [
    [],
    ["stratigraphy.get_diff", "stratigraphy.get_diff"],
    ["get_diff"],
    Array.from({ length: 17 }, (_, index) => `tool.n${index}`),
  ]) {
    assert.throws(
      () => formatRpcCaveat(invalid),
      RangeError,
      invalid.join(","),
    );
  }
});

test("rejects an expired time-boxed macaroon before any wallet or tool work", async () => {
  const gate = await startGatedServer();
  try {
    const parent = await gate.issue();
    const deadline = ISSUED_AT + 60_000;
    const child = attenuateSubscriptionMacaroon(parent, [
      formatTimeCaveat(deadline),
      formatRpcCaveat(["stratigraphy.get_diff"]),
    ]);
    assert.ok(child);
    // At the deadline, just past it, and long after it (the root stays valid).
    for (const at of [deadline, deadline + 1, deadline + 600_000]) {
      gate.clock.now = at;
      const expired = await gate.redeem(child, GET_DIFF);
      assert.equal(expired.status, 401, `server time ${at}`);
      assert.deepEqual(expired.body, {
        error: "Macaroon time caveat has expired",
      });
      assert.equal(
        expired.challenged,
        false,
        "an expired delegation is refused, not re-priced",
      );
    }
    assert.equal(gate.calls.verifications, 0);
    assert.deepEqual(gate.calls.executions, []);
    assert.equal(gate.calls.invoices, 1);
  } finally {
    await gate.close();
  }
});

test("rejects a macaroon whose rpc caveat does not name the requested tool", async () => {
  const gate = await startGatedServer();
  try {
    const parent = await gate.issue();
    const attenuate = (...caveats: string[]) => {
      const child = attenuateSubscriptionMacaroon(parent, caveats);
      assert.ok(child, caveats.join(" | "));
      return child;
    };
    const cases: Array<[string, string, string, string]> = [
      [
        "scoped to a different tool",
        attenuate("rpc = stratigraphy.get_digest"),
        GET_DIFF,
        "stratigraphy.get_diff",
      ],
      [
        "legacy alias is not implied",
        attenuate("rpc = stratigraphy.diff"),
        GET_DIFF,
        "stratigraphy.get_diff",
      ],
      [
        "every rpc caveat must name the tool",
        attenuate(
          "rpc = stratigraphy.get_diff,stratigraphy.get_digest",
          "rpc = stratigraphy.get_digest",
        ),
        GET_DIFF,
        "stratigraphy.get_diff",
      ],
      [
        "presented at another tool gate",
        attenuate("rpc = stratigraphy.get_diff"),
        GET_DIGEST,
        "stratigraphy.get_digest",
      ],
    ];
    for (const [reason, macaroon, path, tool] of cases) {
      const refused = await gate.redeem(macaroon, path);
      assert.equal(refused.status, 403, reason);
      assert.deepEqual(
        refused.body,
        { error: `Macaroon tool caveat does not authorize ${tool}` },
        reason,
      );
    }
    const rest = await gate.redeem(
      attenuate("rpc = stratigraphy.get_diff"),
      "/api/v1/report",
    );
    assert.equal(
      rest.status,
      403,
      "routes without a tool refuse tool-scoped credentials",
    );
    assert.deepEqual(rest.body, {
      error: "Macaroon tool or target caveat forbids this route",
    });
    assert.equal(gate.calls.verifications, 0);
    assert.deepEqual(gate.calls.executions, []);
  } finally {
    await gate.close();
  }
});

test("accepts a correctly attenuated macaroon and keeps its inherited quota", async () => {
  const gate = await startGatedServer();
  try {
    const parent = await gate.issue();
    const deadline = ISSUED_AT + 60_000;
    const child = attenuateSubscriptionMacaroon(parent, [
      formatTimeCaveat(deadline),
      formatRpcCaveat(["stratigraphy.get_diff", "stratigraphy.get_digest"]),
      formatRpcCaveat(["stratigraphy.get_diff"]),
    ]);
    assert.ok(child);
    const pass = verifySubscriptionMacaroon(child, SECRET, ISSUED_AT / 1_000);
    assert.ok(pass);
    assert.equal(pass.timeCaveatDeadline, deadline);
    assert.deepEqual(pass.rpcToolSets, [
      ["stratigraphy.get_diff", "stratigraphy.get_digest"],
      ["stratigraphy.get_diff"],
    ]);
    gate.clock.now = deadline - 1;
    const accepted = await gate.redeem(child, GET_DIFF);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { executed: "stratigraphy.get_diff" });
    assert.equal(gate.calls.verifications, 1);
    assert.deepEqual(gate.calls.executions, ["stratigraphy.get_diff"]);
    const replay = await gate.redeem(child, GET_DIFF);
    assert.equal(
      replay.status,
      429,
      "attenuation never resets the single-use quota",
    );
    assert.deepEqual(gate.calls.executions, ["stratigraphy.get_diff"]);
  } finally {
    await gate.close();
  }
});

test("non-canonical first-party caveats invalidate the whole credential", async () => {
  const gate = await startGatedServer();
  try {
    const parent = await gate.issue();
    const malformed = [
      "time<2026-10-17T12:01:00.000Z",
      "time < 2026-10-17T12:01:00Z",
      "time < 2026-10-17T12:01:00.000+00:00",
      "time < 2026-02-30T12:01:00.000Z",
      "time <= 2026-10-17T12:01:00.000Z",
      "time > 2026-10-17T12:01:00.000Z",
      "rpc=stratigraphy.get_diff",
      "rpc = stratigraphy.get_diff ",
      "rpc = stratigraphy.get_diff, stratigraphy.get_digest",
      "rpc = stratigraphy.get_diff,stratigraphy.get_diff",
      "rpc = Stratigraphy.get_diff",
      "rpc = ",
      "rpc = *",
      "rpc != stratigraphy.get_digest",
    ];
    for (const caveat of malformed) {
      assert.equal(parseDelegationCaveat(caveat), null, caveat);
      assert.equal(
        attenuateSubscriptionMacaroon(parent, [caveat]),
        null,
        caveat,
      );
      // A holder can still sign arbitrary bytes onto the chain; verification
      // must refuse the credential rather than skip the unparseable caveat.
      const forged = appendRawCaveat(parent, caveat);
      assert.equal(
        verifySubscriptionMacaroon(forged, SECRET, ISSUED_AT / 1_000),
        null,
        caveat,
      );
      const refused = await gate.redeem(forged, GET_DIFF);
      assert.equal(refused.status, 402, caveat);
      assert.equal(
        refused.challenged,
        true,
        "an unauthentic credential earns only a fresh challenge",
      );
    }
    assert.equal(gate.calls.verifications, 0);
    assert.deepEqual(gate.calls.executions, []);
  } finally {
    await gate.close();
  }
});
