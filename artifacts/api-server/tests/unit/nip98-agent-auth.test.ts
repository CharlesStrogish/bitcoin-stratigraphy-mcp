import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import {
  AGENT_AUTHENTICATION_CAVEAT,
  AGENT_ID_HEADER,
  agentBindingRejection,
  parseAgentAuthenticationCaveat,
} from "../../src/lib/agent-id-caveat";
import {
  createSubscriptionMacaroon,
  inspectSubscriptionMacaroon,
} from "../../src/lib/subscription-pass";
import { createL402Middleware } from "../../src/middleware/l402";
import type { SettlementRouter } from "../../src/services/settlement";

const sha256Hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const SECRET = "nip98-agent-authentication-secret";
const PREIMAGE = "0b".repeat(32);
const PAYMENT_HASH = sha256Hex(Buffer.from(PREIMAGE, "hex"));
const ISSUED_AT = Date.parse("2026-10-18T12:00:00.000Z");
const ISSUED_AT_SECONDS = ISSUED_AT / 1_000;
const DESCRIPTION = "NIP-98 agent authentication test execution";
const ROUTE = "/api/v1/authenticated";
const BODY = JSON.stringify({ task: "classify", input: "block 900000" });
const SETTLED = {
  paymentHash: PAYMENT_HASH,
  settledAt: ISSUED_AT_SECONDS,
  provider: "test-wallet",
};
const INVALID = { error: "Invalid NIP-98 authorization" };

const agentKey = generateSecretKey();
const agentPubkey = getPublicKey(agentKey);
const otherKey = generateSecretKey();
const otherPubkey = getPublicKey(otherKey);

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

const encodeEvent = (event: object) =>
  `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
const decodeEvent = (authorization: string) =>
  JSON.parse(
    Buffer.from(authorization.slice("Nostr ".length), "base64").toString(
      "utf8",
    ),
  ) as Record<string, unknown> & { sig: string; created_at: number };

/** A kind 27235 NIP-98 event; `payload: null` omits the payload tag. */
function signNip98(options: {
  url: string;
  payload: string | null;
  method?: string;
  createdAt?: number;
  kind?: number;
  key?: Uint8Array;
}): string {
  const tags = [
    ["u", options.url],
    ["method", options.method ?? "POST"],
    ...(options.payload === null
      ? []
      : [["payload", sha256Hex(options.payload)]]),
  ];
  return encodeEvent(
    finalizeEvent(
      {
        kind: options.kind ?? 27_235,
        created_at: options.createdAt ?? ISSUED_AT_SECONDS,
        tags,
        content: "",
      },
      options.key ?? agentKey,
    ),
  );
}

const l402 = (macaroon: string) => `L402 ${macaroon}:${PREIMAGE}`;

/** One gated route with a counting wallet; the handler echoes the verified locals. */
async function startGatedServer(options: { captureRawBody?: boolean } = {}) {
  const calls = { invoices: 0, verifications: 0, executions: 0 };
  const settlementRouter: SettlementRouter = {
    isConfigured: () => true,
    activeProvider: () => "test-wallet",
    circuitState: () => "closed",
    async createInvoice() {
      calls.invoices += 1;
      return {
        invoice: `lnbc5n1nip98${calls.invoices}`,
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
        ? { settledAt: ISSUED_AT_SECONDS, provider: "test-wallet" }
        : "invalid";
    },
  };
  const app = express();
  app.use(
    options.captureRawBody
      ? express.json({
          verify(req, _res, buffer) {
            (req as express.Request & { rawBody?: Buffer }).rawBody =
              Buffer.from(buffer);
          },
        })
      : express.json(),
  );
  app.post(
    ROUTE,
    createL402Middleware({
      amountSats: 5,
      description: DESCRIPTION,
      settlementRouter,
      sessionSecret: SECRET,
      now: () => ISSUED_AT,
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
  return {
    url,
    calls,
    /** `authorization` is sent raw; `nostr` goes in X-Nostr-Authorization. */
    async send(request: {
      body?: string;
      authorization?: string;
      nostr?: string;
      agentId?: string;
    }) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (request.authorization !== undefined)
        headers.Authorization = request.authorization;
      if (request.nostr !== undefined)
        headers["X-Nostr-Authorization"] = request.nostr;
      if (request.agentId !== undefined)
        headers[AGENT_ID_HEADER] = request.agentId;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: request.body ?? BODY,
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

test("a valid NIP-98 signature binds its pubkey as the authenticated agent_id on every use", async () => {
  const server = await startGatedServer();
  try {
    const challenge = await server.send({
      authorization: signNip98({ url: server.url, payload: BODY }),
    });
    assert.equal(challenge.status, 402);
    assert.equal(challenge.challenged, true);
    assert.equal(challenge.body.agent_id, agentPubkey);
    assert.equal(challenge.body.agent_authentication, "nip98");
    const macaroon = challenge.body.macaroon as string;
    const caveats = decode(macaroon).caveats;
    assert.equal(
      caveats.filter((caveat) => caveat === `agent_id = ${agentPubkey}`).length,
      1,
    );
    assert.equal(
      caveats.filter((caveat) => caveat === AGENT_AUTHENTICATION_CAVEAT).length,
      1,
    );
    const pass = inspectSubscriptionMacaroon(macaroon, SECRET);
    assert.equal(pass?.agentId, agentPubkey);
    assert.equal(pass?.agentAuthentication, "nip98");

    // Neither the bare declaration nor another key's valid event redeems it,
    // and refused attempts never reach the wallet or spend the credential.
    const declaredOnly = await server.send({
      authorization: l402(macaroon),
      agentId: agentPubkey,
    });
    assert.equal(declaredOnly.status, 401);
    assert.match(
      String(declaredOnly.body.error),
      /NIP-98 authenticated agent_id/,
    );
    const impostor = await server.send({
      authorization: l402(macaroon),
      nostr: signNip98({ url: server.url, payload: BODY, key: otherKey }),
    });
    assert.equal(impostor.status, 403);
    assert.match(String(impostor.body.error), /NIP-98 signer does not match/);
    assert.deepEqual(server.calls, {
      invoices: 1,
      verifications: 0,
      executions: 0,
    });

    const redeemed = await server.send({
      authorization: l402(macaroon),
      nostr: signNip98({ url: server.url, payload: BODY }),
    });
    assert.equal(redeemed.status, 200);
    assert.deepEqual(redeemed.body.l402, {
      ...SETTLED,
      agentId: agentPubkey,
      agentAuthentication: "nip98",
    });
    assert.deepEqual(server.calls, {
      invoices: 1,
      verifications: 1,
      executions: 1,
    });

    // X-Nostr-Authorization authenticates a challenge the same way.
    const supplemental = await server.send({
      nostr: signNip98({ url: server.url, payload: BODY, key: otherKey }),
    });
    assert.equal(supplemental.status, 402);
    assert.equal(supplemental.body.agent_id, otherPubkey);
    assert.equal(supplemental.body.agent_authentication, "nip98");
  } finally {
    await server.close();
  }
});

test("forged or invalid NIP-98 events fail with 401 before any invoice or redemption", async () => {
  const server = await startGatedServer();
  try {
    const event = decodeEvent(signNip98({ url: server.url, payload: BODY }));
    const lastNibble = event.sig.endsWith("0") ? "1" : "0";
    const cases: Array<[string, string]> = [
      [
        "forged signature",
        encodeEvent({ ...event, sig: event.sig.slice(0, -1) + lastNibble }),
      ],
      ["claimed pubkey", encodeEvent({ ...event, pubkey: otherPubkey })],
      [
        "re-dated without re-signing",
        encodeEvent({ ...event, created_at: event.created_at - 1 }),
      ],
      ["wrong URL", signNip98({ url: `${server.url}/other`, payload: BODY })],
      [
        "wrong method",
        signNip98({ url: server.url, payload: BODY, method: "GET" }),
      ],
      [
        "different body",
        signNip98({
          url: server.url,
          payload: JSON.stringify({ task: "other" }),
        }),
      ],
      ["missing payload tag", signNip98({ url: server.url, payload: null })],
      [
        "stale event",
        signNip98({
          url: server.url,
          payload: BODY,
          createdAt: ISSUED_AT_SECONDS - 61,
        }),
      ],
      [
        "future event",
        signNip98({
          url: server.url,
          payload: BODY,
          createdAt: ISSUED_AT_SECONDS + 1,
        }),
      ],
      ["wrong kind", signNip98({ url: server.url, payload: BODY, kind: 1 })],
      ["malformed encoding", "Nostr not-base64!"],
    ];
    for (const [label, authorization] of cases) {
      for (const placement of ["authorization", "nostr"] as const) {
        const response = await server.send(
          placement === "authorization"
            ? { authorization }
            : { nostr: authorization },
        );
        assert.equal(response.status, 401, `${label} in ${placement}`);
        assert.deepEqual(response.body, INVALID, `${label} in ${placement}`);
        assert.equal(response.challenged, false, `${label} in ${placement}`);
      }
    }
    assert.deepEqual(server.calls, {
      invoices: 0,
      verifications: 0,
      executions: 0,
    });

    // A forged event beside a paid authenticated credential is also refused,
    // without a wallet lookup or spending the single use.
    const challenge = await server.send({
      authorization: signNip98({ url: server.url, payload: BODY }),
    });
    const macaroon = challenge.body.macaroon as string;
    const forgedUse = await server.send({
      authorization: l402(macaroon),
      nostr: cases[0]![1],
    });
    assert.equal(forgedUse.status, 401);
    assert.deepEqual(forgedUse.body, INVALID);
    assert.deepEqual(server.calls, {
      invoices: 1,
      verifications: 0,
      executions: 0,
    });
    const genuineUse = await server.send({
      authorization: l402(macaroon),
      nostr: signNip98({ url: server.url, payload: BODY }),
    });
    assert.equal(genuineUse.status, 200);
    assert.equal(server.calls.executions, 1);
  } finally {
    await server.close();
  }
});

test("standard unauthenticated requests keep self-declared or anonymous attribution", async () => {
  const server = await startGatedServer();
  try {
    // LangChain-style declaration: bound by the HMAC chain, never authenticated.
    const declared = await server.send({ agentId: "langchain-agent-7" });
    assert.equal(declared.status, 402);
    assert.equal(declared.body.agent_id, "langchain-agent-7");
    assert.equal(Object.hasOwn(declared.body, "agent_authentication"), false);
    const declaredMacaroon = declared.body.macaroon as string;
    assert.equal(
      decode(declaredMacaroon).caveats.includes(AGENT_AUTHENTICATION_CAVEAT),
      false,
    );
    assert.equal(
      inspectSubscriptionMacaroon(declaredMacaroon, SECRET)
        ?.agentAuthentication,
      undefined,
    );
    const declaredUse = await server.send({
      authorization: l402(declaredMacaroon),
      agentId: "langchain-agent-7",
    });
    assert.equal(declaredUse.status, 200);
    assert.deepEqual(declaredUse.body.l402, {
      ...SETTLED,
      agentId: "langchain-agent-7",
    });

    // No identity at all stays unattributed.
    const anonymous = await server.send({});
    assert.equal(anonymous.status, 402);
    assert.equal(Object.hasOwn(anonymous.body, "agent_id"), false);
    assert.equal(Object.hasOwn(anonymous.body, "agent_authentication"), false);
    const anonymousUse = await server.send({
      authorization: l402(anonymous.body.macaroon as string),
    });
    assert.equal(anonymousUse.status, 200);
    assert.deepEqual(anonymousUse.body.l402, SETTLED);
    assert.equal(server.calls.executions, 2);
  } finally {
    await server.close();
  }
});

test("a NIP-98 signer must equal any declared agent_id and cannot upgrade a self-declared credential", async () => {
  const server = await startGatedServer();
  try {
    const conflictingHeader = await server.send({
      authorization: signNip98({ url: server.url, payload: BODY }),
      agentId: "planner-7",
    });
    assert.equal(conflictingHeader.status, 400);
    assert.equal(conflictingHeader.challenged, false);
    const bodyWithAgent = JSON.stringify({
      task: "classify",
      agent_id: "planner-7",
    });
    const conflictingBody = await server.send({
      body: bodyWithAgent,
      authorization: signNip98({ url: server.url, payload: bodyWithAgent }),
    });
    assert.equal(conflictingBody.status, 400);
    assert.equal(server.calls.invoices, 0);

    const matching = await server.send({
      authorization: signNip98({ url: server.url, payload: BODY }),
      agentId: agentPubkey,
    });
    assert.equal(matching.status, 402);
    assert.equal(matching.body.agent_authentication, "nip98");

    // A self-declared pubkey binding accepts its signer as the declaration,
    // but stays unauthenticated: authentication is fixed at issuance.
    const selfDeclared = await server.send({ agentId: agentPubkey });
    assert.equal(
      Object.hasOwn(selfDeclared.body, "agent_authentication"),
      false,
    );
    const selfDeclaredMacaroon = selfDeclared.body.macaroon as string;
    const otherSigner = await server.send({
      authorization: l402(selfDeclaredMacaroon),
      nostr: signNip98({ url: server.url, payload: BODY, key: otherKey }),
    });
    assert.equal(otherSigner.status, 403);
    const signedUse = await server.send({
      authorization: l402(selfDeclaredMacaroon),
      nostr: signNip98({ url: server.url, payload: BODY }),
    });
    assert.equal(signedUse.status, 200);
    assert.deepEqual(signedUse.body.l402, { ...SETTLED, agentId: agentPubkey });

    // Holders may append the authentication caveat; it only adds the
    // requirement that every use re-sign with the bound key.
    const restricted = appendRawCaveat(
      (await server.send({ agentId: otherPubkey })).body.macaroon as string,
      AGENT_AUTHENTICATION_CAVEAT,
    );
    const unsignedRestricted = await server.send({
      authorization: l402(restricted),
      agentId: otherPubkey,
    });
    assert.equal(unsignedRestricted.status, 401);
    const signedRestricted = await server.send({
      authorization: l402(restricted),
      nostr: signNip98({ url: server.url, payload: BODY, key: otherKey }),
    });
    assert.equal(signedRestricted.status, 200);
    assert.deepEqual(signedRestricted.body.l402, {
      ...SETTLED,
      agentId: otherPubkey,
      agentAuthentication: "nip98",
    });
  } finally {
    await server.close();
  }
});

test("the payload tag binds the exact request bytes when the raw body is captured", async () => {
  const server = await startGatedServer({ captureRawBody: true });
  try {
    const spaced = '{ "task": "classify",  "input": "block 900000" }';
    const reserialized = await server.send({
      body: spaced,
      authorization: signNip98({
        url: server.url,
        payload: JSON.stringify(JSON.parse(spaced)),
      }),
    });
    assert.equal(reserialized.status, 401);
    assert.deepEqual(reserialized.body, INVALID);
    const exact = await server.send({
      body: spaced,
      authorization: signNip98({ url: server.url, payload: spaced }),
    });
    assert.equal(exact.status, 402);
    assert.equal(exact.body.agent_id, agentPubkey);
    assert.equal(exact.body.agent_authentication, "nip98");
  } finally {
    await server.close();
  }
});

test("the authentication caveat qualifies exactly one lowercase Nostr pubkey agent_id", () => {
  assert.equal(
    parseAgentAuthenticationCaveat("agent_authentication = nip98"),
    "nip98",
  );
  for (const variant of [
    "agent_authentication=nip98",
    "agent_authentication = NIP98",
    "agent_authentication = nip-98",
    " agent_authentication = nip98",
    "agent_authentication = nip98 ",
  ]) {
    assert.equal(parseAgentAuthenticationCaveat(variant), null, variant);
  }
  const root = (extra: { agentId?: string; agentAuthentication?: "nip98" }) =>
    createSubscriptionMacaroon({
      secret: SECRET,
      paymentHash: PAYMENT_HASH,
      tier: "1-day",
      validUntil: ISSUED_AT_SECONDS + 3_600,
      ...extra,
    });
  for (const agentId of [undefined, "planner-7", agentPubkey.toUpperCase()]) {
    assert.throws(
      () =>
        root({
          ...(agentId === undefined ? {} : { agentId }),
          agentAuthentication: "nip98",
        }),
      RangeError,
    );
  }
  const authenticated = root({
    agentId: agentPubkey,
    agentAuthentication: "nip98",
  });
  assert.equal(
    inspectSubscriptionMacaroon(authenticated, SECRET)?.agentAuthentication,
    "nip98",
  );
  // Duplicate, unbound and non-pubkey authentication caveats fail closed.
  for (const invalid of [
    appendRawCaveat(authenticated, AGENT_AUTHENTICATION_CAVEAT),
    appendRawCaveat(root({}), AGENT_AUTHENTICATION_CAVEAT),
    appendRawCaveat(
      root({ agentId: "planner-7" }),
      AGENT_AUTHENTICATION_CAVEAT,
    ),
  ]) {
    assert.equal(inspectSubscriptionMacaroon(invalid, SECRET), null);
  }

  const bound = { agentId: agentPubkey, agentAuthentication: "nip98" as const };
  assert.equal(
    agentBindingRejection(bound, { declared: agentPubkey })?.status,
    401,
  );
  assert.equal(
    agentBindingRejection(bound, { nip98Pubkey: otherPubkey })?.status,
    403,
  );
  assert.equal(
    agentBindingRejection(bound, { nip98Pubkey: agentPubkey }),
    null,
  );
  assert.equal(
    agentBindingRejection({}, { nip98Pubkey: agentPubkey })?.status,
    403,
  );
  assert.equal(agentBindingRejection({}, {}), null);
});
