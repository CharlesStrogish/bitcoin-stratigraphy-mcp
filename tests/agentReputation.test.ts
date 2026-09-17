import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools";
import {
  AGENT_TIER_POLICIES,
  createAgentReputationService,
} from "../artifacts/api-server/src/services/agentReputation";
import {
  createSubscriptionMacaroon,
  verifySubscriptionMacaroon,
} from "../artifacts/api-server/src/lib/subscription-pass";

const nowSeconds = 1_789_646_400;
const vipKey = generateSecretKey();
const vipPubkey = getPublicKey(vipKey);
const swarmKey = generateSecretKey();
const swarmPubkey = getPublicKey(swarmKey);

const reputation = createAgentReputationService({
  tiers: {
    [vipPubkey]: "VIP",
    [swarmPubkey]: "SWARM",
  },
  now: () => nowSeconds * 1_000,
});

function nip98Authorization(input: {
  key: Uint8Array;
  url: string;
  method: string;
  createdAt?: number;
  payload?: string;
  extraTags?: string[][];
}) {
  const event = finalizeEvent(
    {
      kind: 27_235,
      created_at: input.createdAt ?? nowSeconds,
      tags: [
        ["u", input.url],
        ["method", input.method],
        ...(input.payload === undefined
          ? []
          : [
              [
                "payload",
                createHash("sha256").update(input.payload).digest("hex"),
              ],
            ]),
        ...(input.extraTags ?? []),
      ],
      content: "",
    },
    input.key,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

test("calculates tier discounts and rate-limit multipliers", () => {
  const standard = reputation.identityForPubkey("ab".repeat(32));
  const vip = reputation.identityForPubkey(vipPubkey);
  const swarm = reputation.identityForPubkey(swarmPubkey);

  assert.equal(standard.tier, "STANDARD");
  assert.deepEqual(
    {
      discountPercent: vip.discountPercent,
      rateLimitMultiplier: vip.rateLimitMultiplier,
    },
    AGENT_TIER_POLICIES.VIP,
  );
  assert.deepEqual(
    {
      discountPercent: swarm.discountPercent,
      rateLimitMultiplier: swarm.rateLimitMultiplier,
    },
    AGENT_TIER_POLICIES.SWARM,
  );
  assert.deepEqual(reputation.applyPricing(100, vip), {
    ...vip,
    originalPriceSats: 100,
    priceSats: 85,
    discountSats: 15,
  });
  assert.equal(reputation.applyPricing(100, swarm).priceSats, 70);
});

test("verifies a fresh NIP-98 signature bound to URL and method", () => {
  const url = "https://data.example/api/v1/cost";
  const authorization = nip98Authorization({
    key: vipKey,
    url,
    method: "GET",
  });

  assert.deepEqual(
    reputation.verifyNip98Authorization({
      authorization,
      method: "GET",
      url,
      nowSeconds,
    }),
    reputation.identityForPubkey(vipPubkey),
  );
  assert.equal(
    reputation.verifyNip98Authorization({
      authorization,
      method: "POST",
      url,
      nowSeconds,
    }),
    null,
  );
  assert.equal(
    reputation.verifyNip98Authorization({
      authorization,
      method: "GET",
      url: `${url}?different=true`,
      nowSeconds,
    }),
    null,
  );
});

test("rejects stale and cryptographically invalid NIP-98 events", () => {
  const url = "https://data.example/api/v1/stratigraphy";
  const stale = nip98Authorization({
    key: vipKey,
    url,
    method: "GET",
    createdAt: nowSeconds - 61,
  });
  const future = nip98Authorization({
    key: vipKey,
    url,
    method: "GET",
    createdAt: nowSeconds + 1,
  });
  const valid = nip98Authorization({
    key: vipKey,
    url,
    method: "GET",
  });
  const event = JSON.parse(
    Buffer.from(valid.slice("Nostr ".length), "base64").toString("utf8"),
  );
  event.tags[0][1] = `${url}?tampered=true`;
  const tampered = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;

  assert.equal(
    reputation.verifyNip98Authorization({
      authorization: stale,
      method: "GET",
      url,
      nowSeconds,
    }),
    null,
  );
  assert.equal(
    reputation.verifyNip98Authorization({
      authorization: future,
      method: "GET",
      url,
      nowSeconds,
    }),
    null,
  );
  assert.equal(
    reputation.verifyNip98Authorization({
      authorization: tampered,
      method: "GET",
      url: `${url}?tampered=true`,
      nowSeconds,
    }),
    null,
  );
});

test("requires NIP-98 POST signatures to bind the exact payload", () => {
  const url = "https://data.example/api/v1/macaroon/attenuate";
  const payload = JSON.stringify({
    macaroon: "parent",
    caveats: ["max_requests=2"],
  });
  const authorization = nip98Authorization({
    key: vipKey,
    url,
    method: "POST",
    payload,
  });

  assert.ok(
    reputation.verifyNip98Authorization({
      authorization,
      method: "POST",
      url,
      nowSeconds,
      payload,
    }),
  );
  assert.equal(
    reputation.verifyNip98Authorization({
      authorization,
      method: "POST",
      url,
      nowSeconds,
      payload: `${payload} `,
    }),
    null,
  );
});

test("requires exact canonical NIP-98 URL, method, and tag cardinality", () => {
  const url = "https://data.example/api/v1/cost";
  for (const authorization of [
    nip98Authorization({
      key: vipKey,
      url: "https://DATA.example/api/v1/cost",
      method: "GET",
    }),
    nip98Authorization({
      key: vipKey,
      url: "https://data.example:443/api/v1/cost",
      method: "GET",
    }),
    nip98Authorization({
      key: vipKey,
      url,
      method: "get",
    }),
    nip98Authorization({
      key: vipKey,
      url,
      method: "GET",
      extraTags: [
        ["payload", "00".repeat(32)],
        ["payload", "11".repeat(32)],
      ],
    }),
  ]) {
    assert.equal(
      reputation.verifyNip98Authorization({
        authorization,
        method: "GET",
        url,
        nowSeconds,
      }),
      null,
    );
  }
});

test("rejects malformed NIP-98 event structures without throwing", () => {
  const url = "https://data.example/api/v1/cost";
  for (const malformed of [
    { tags: null },
    { tags: ["not-a-tag"] },
    { tags: [null] },
  ]) {
    const authorization = `Nostr ${Buffer.from(JSON.stringify(malformed)).toString("base64")}`;
    assert.doesNotThrow(() => {
      assert.equal(
        reputation.verifyNip98Authorization({
          authorization,
          method: "GET",
          url,
          nowSeconds,
        }),
        null,
      );
    });
  }
});

test("binds agent pubkey and tier caveats into subscription macaroons", () => {
  const secret = "agent-caveat-test-secret";
  const vip = reputation.identityForPubkey(vipPubkey);
  const macaroon = createSubscriptionMacaroon({
    secret,
    paymentHash: "cd".repeat(32),
    tier: "1-day",
    validUntil: nowSeconds + 3_600,
    amountMsats: 85_000,
    agentIdentity: vip,
  });

  const verified = verifySubscriptionMacaroon(
    macaroon,
    secret,
    nowSeconds,
    vip,
  );
  assert.equal(verified?.agentPubkey, vipPubkey);
  assert.equal(verified?.agentTier, "VIP");
  assert.equal(verified?.amountMsats, 85_000);
  assert.equal(
    verifySubscriptionMacaroon(macaroon, secret, nowSeconds, null),
    null,
  );
  assert.equal(
    verifySubscriptionMacaroon(
      macaroon,
      secret,
      nowSeconds,
      reputation.identityForPubkey(swarmPubkey),
    ),
    null,
  );
});