import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BitcoinStratigraphyClient, StratigraphyClient, type X402PaymentTerms } from "./client.js";

const preimage = "11".repeat(32);
const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const invoice = "lnbc123test";
const macaroon = "scope-bound-macaroon";
const challenge = {
  invoice, macaroon, payment_hash: paymentHash, amount_sats: 250,
};
const challengeHeader = `L402 macaroon="${macaroon}", invoice="${invoice}"`;
const baseUsdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const x402Terms: X402PaymentTerms = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:8453",
    asset: baseUsdc,
    amount: "125000",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    extra: { paymentFlow: "upfront", name: "USD Coin", version: "2" },
  },
  resource: { url: "https://example.test/mcp" },
};

function encodeBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function x402Required(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(null, {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encodeBase64({
        x402Version: 2,
        resource: { url: "https://example.test/mcp" },
        accepts: [{
          scheme: "exact",
          network: "eip155:8453",
          asset: baseUsdc,
          amount: "125000",
          payTo: x402Terms.accepted.payTo,
          maxTimeoutSeconds: 60,
          extra: { paymentFlow: "upfront", name: "USD Coin", version: "2" },
          ...overrides,
        }],
      }),
    },
  });
}

function dualRailRequired(): Response {
  return new Response(JSON.stringify(challenge), {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encodeBase64({
        x402Version: 2,
        resource: { url: "https://example.test/mcp" },
        accepts: [{
          scheme: "exact",
          network: "eip155:8453",
          asset: baseUsdc,
          amount: "125000",
          payTo: x402Terms.accepted.payTo,
          maxTimeoutSeconds: 60,
          extra: { paymentFlow: "upfront", name: "USD Coin", version: "2" },
        }],
      }),
      "WWW-Authenticate": challengeHeader,
      "Content-Type": "application/json",
    },
  });
}

function x402Signature(overrides: {
  accepted?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  resource?: Record<string, unknown>;
} = {}): string {
  return encodeBase64({
    x402Version: 2,
    accepted: { ...x402Terms.accepted, ...overrides.accepted },
    payload: {
      signature: "0xdeadbeef",
      authorization: {
        to: x402Terms.accepted.payTo,
        value: x402Terms.accepted.amount,
      },
      ...overrides.payload,
    },
    resource: overrides.resource ?? x402Terms.resource,
  });
}

function rpc(result: unknown, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function paymentRequired(
  body: Record<string, unknown> = challenge,
  header = challengeHeader,
): Response {
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "WWW-Authenticate": header, "Content-Type": "application/json" },
  });
}

test("free tools work without a wallet and return structured JSON", async () => {
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    undefined,
    (async (_url, init) => {
      assert.equal(init?.method, "POST");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.params.name, "mesh.get_status");
      assert.deepEqual(payload.params.arguments, {});
      assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
      return rpc({ structuredContent: { topologyHealth: "isolated" } });
    }) as typeof fetch,
  );
  const result = await client.getMeshStatus();
  assert.equal(result.topologyHealth, "isolated");
});

test("SDK convenience methods call canonical renamed tools", async () => {
  const names: string[] = [];
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    undefined,
    (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      names.push(request.params.name);
      return rpc({ structuredContent: {} }, request.id);
    }) as typeof fetch,
  );

  await client.getPaymentInfo();
  await client.getStratigraphyDigest({ target: "latest" });
  await client.getStratigraphyDiff({ fromTarget: "2026-09-01" });
  await client.getStratigraphyRange({ startTarget: "2026-09-01" });

  assert.deepEqual(names, [
    "payment.get_info",
    "stratigraphy.get_digest",
    "stratigraphy.get_diff",
    "stratigraphy.get_range",
  ]);
});

test("issues epistemic receipts using the canonical MCP tool name", async () => {
  const signedReceipt = {
    schema: "bitcoin-stratigraphy/cryptographic-attestation/v1",
    payload: {
      schema: "bitcoin-stratigraphy/epistemic-anchor/v1",
      contextHash: "cd".repeat(32),
      agentId: "mcp:proof.epistemic_receipt",
      metadata: { cid: "bafy-example", nostrEventId: "ab".repeat(32) },
      bitcoin: {
        blockHeight: 900_000,
        blockHash: "ef".repeat(32),
        source: "https://mempool.space/api",
      },
      timestamp: 1_788_912_000_000,
    },
    proof: {
      algorithm: "sha256",
      payloadSha256: "12".repeat(32),
      blockSizeBytes: 1024,
      blockHashes: ["34".repeat(32)],
      merkleRoot: "56".repeat(32),
      timestamp: 1_788_912_000_000,
    },
    signature: { protocol: "nostr", nip: 78, payload_sha256: "78".repeat(32), event: {} },
    receiptSchema: "bitcoin-stratigraphy/epistemic-anchor/v1",
    contextHash: "cd".repeat(32),
    agentId: "mcp:proof.epistemic_receipt",
    blockHeight: 900_000,
    blockHash: "ef".repeat(32),
    merkleRoot: "56".repeat(32),
    timestamp: 1_788_912_000_000,
    nostrSignature: { protocol: "nostr", nip: 78, payload_sha256: "78".repeat(32), event: {} },
  };
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    undefined,
    (async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.params.name, "proof.issue_receipt");
      assert.deepEqual(payload.params.arguments, {
        cid: "bafy-example", nostrEventId: "ab".repeat(32),
      });
      return rpc({ structuredContent: {
        receiptHash: "cd".repeat(32),
        blockTip: 900_000,
        blockHash: "ef".repeat(32),
        ipfsCid: "bafy-example",
        nostrEventId: "ab".repeat(32),
        attestation: {
          type: "Signed-Bitcoin-Tip-Anchor",
          proofPayload: JSON.stringify(signedReceipt),
          verified: true,
        },
        timestamp: "2026-09-09T00:00:00.000Z",
      } });
    }) as typeof fetch,
  );
  const receipt = await client.issueEpistemicReceipt({
    cid: "bafy-example",
    nostrEventId: "ab".repeat(32),
  });
  assert.equal(receipt.attestation.type, "Signed-Bitcoin-Tip-Anchor");
  assert.deepEqual(
    JSON.parse(receipt.attestation.proofPayload),
    signedReceipt,
  );
  assert.equal(receipt.attestation.verified, true);
});

test("looks up proof status by the canonical receiptHash selector", async () => {
  const receiptHash = "cd".repeat(32);
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    undefined,
    (async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.params.name, "proof.get_status");
      assert.deepEqual(payload.params.arguments, { receiptHash });
      return rpc({ structuredContent: {
        status: "verified",
        verifiedAt: "2026-09-09T00:00:00.000Z",
        attestationCount: 0,
        meshQuorum: false,
      } });
    }) as typeof fetch,
  );
  const status = await client.getProofStatus({ receiptHash });
  assert.equal(status.status, "verified");
});

test("calls server-advertised tools by string name with generic arguments", async () => {
  const client = new StratigraphyClient(
    "https://example.test/mcp",
    { fetcher: (async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.params.name, "server.new_tool");
      assert.deepEqual(request.params.arguments, { limit: 4 });
      return rpc({ structuredContent: { accepted: true } });
    }) as typeof fetch },
  );
  assert.deepEqual(await client.callTool("server.new_tool", { limit: 4 }), { accepted: true });
});

test("pays the WWW-Authenticate invoice once and retries the exact tool call", async () => {
  let paid = 0;
  const requests: Array<{ body: string; authorization?: string }> = [];
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    async (requestedInvoice) => {
      assert.equal(requestedInvoice, invoice);
      paid++;
      return { preimage };
    },
    (async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({ body: String(init?.body), authorization: headers.Authorization });
      return requests.length === 1
        ? paymentRequired()
        : rpc({ structuredContent: {
          signalType: "telemetry_snapshot",
          date: "2026-09-09",
          snapshotDigest: "ab".repeat(32),
          peerAttestations: 1,
          quorumThreshold: 2,
          merkleRoot: "cd".repeat(32),
          networkId: "bitcoin-stratigraphy-mainnet-v1",
        } });
    }) as typeof fetch,
  );
  const receipt = await client.broadcastMeshSignal("2026-09-09");
  assert.equal(receipt.peerAttestations, 1);
  assert.equal(paid, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body, requests[1]?.body);
  assert.equal(requests[0]?.authorization, undefined);
  assert.equal(requests[1]?.authorization, `L402 ${macaroon}:${preimage}`);
  assert.deepEqual(JSON.parse(requests[0]!.body).params.arguments, {
    signalType: "telemetry_snapshot", payload: { date: "2026-09-09" },
  });
});

test("forwards a CoinOS internal-payment UUID once for server verification", async () => {
  const reference = "123E4567-E89B-12D3-A456-426614174000";
  let payments = 0;
  const headers: Array<string | undefined> = [];
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    async () => { payments++; return { preimage: reference }; },
    (async (_url, init) => {
      headers.push((init?.headers as Record<string, string>).Authorization);
      return headers.length === 1 ? paymentRequired() : rpc({ structuredContent: { totalSnapshots: 1 } });
    }) as typeof fetch,
  );
  await client.listStratigraphy();
  assert.equal(payments, 1);
  assert.deepEqual(headers, [undefined, `L402 ${macaroon}:${reference.toLowerCase()}`]);
});

test("rejects missing or conflicting L402 headers before paying", async () => {
  for (const response of [
    paymentRequired(challenge, ""),
    paymentRequired({ ...challenge, invoice: "lnbc-other" }),
  ]) {
    let paid = false;
    const client = new BitcoinStratigraphyClient(
      "https://example.test/mcp",
      async () => { paid = true; return preimage; },
      (async () => response) as typeof fetch,
    );
    await assert.rejects(client.getTelemetry({ days: 1 }), /L402|challenge/i);
    assert.equal(paid, false);
  }
});

test("rejects unbound wallet preimages without transmitting them", async () => {
  let requests = 0;
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    async () => "22".repeat(32),
    (async () => { requests++; return paymentRequired(); }) as typeof fetch,
  );
  await assert.rejects(client.listProofs(), /preimage does not match/);
  assert.equal(requests, 1);
});

test("never pays a second invoice if the retry receives another 402", async () => {
  let payments = 0;
  let requests = 0;
  const client = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    async () => { payments++; return preimage; },
    (async () => { requests++; return paymentRequired(); }) as typeof fetch,
  );
  await assert.rejects(client.listStratigraphy(), /not paying again/);
  assert.equal(payments, 1);
  assert.equal(requests, 2);
});

test("uses a configured agent signer for x402 v2 and retries the exact request once", async () => {
  let signedTerms: X402PaymentTerms | undefined;
  const requests: Array<{ body: string; signature?: string; authorization?: string }> = [];
  const signature = x402Signature();
  const client = new StratigraphyClient("https://example.test/mcp", {
    maxPaymentMicroUsdc: 200_000,
    x402Wallet: async (terms) => {
      signedTerms = terms;
      return signature;
    },
    fetcher: (async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({
        body: String(init?.body),
        signature: headers["PAYMENT-SIGNATURE"],
        authorization: headers.Authorization,
      });
      return requests.length === 1
        ? dualRailRequired()
        : rpc({ structuredContent: { topologyHealth: "healthy" } });
    }) as typeof fetch,
  });
  const result = await client.getMeshStatus();
  assert.equal(result.topologyHealth, "healthy");
  assert.deepEqual(signedTerms, x402Terms);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body, requests[1]?.body);
  assert.equal(requests[0]?.signature, undefined);
  assert.equal(requests[1]?.signature, signature);
  assert.equal(requests[1]?.authorization, undefined);
});

test("falls back to L402 when both payment headers are present and no x402 signer is configured", async () => {
  const requests: Array<{ authorization?: string; signature?: string }> = [];
  const client = new StratigraphyClient("https://example.test/mcp", {
    wallet: async (requestedInvoice) => {
      assert.equal(requestedInvoice, invoice);
      return preimage;
    },
    fetcher: (async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      requests.push({
        authorization: headers.Authorization,
        signature: headers["PAYMENT-SIGNATURE"],
      });
      return requests.length === 1
        ? dualRailRequired()
        : rpc({ structuredContent: { totalSnapshots: 1 } });
    }) as typeof fetch,
  });
  const result = await client.listStratigraphy();
  assert.equal(result.totalSnapshots, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.authorization, undefined);
  assert.equal(requests[0]?.signature, undefined);
  assert.equal(requests[1]?.authorization, `L402 ${macaroon}:${preimage}`);
  assert.equal(requests[1]?.signature, undefined);
});

test("rejects tampered x402 metadata before signing or transmitting", async () => {
  for (const response of [
    new Response(null, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodeBase64({
          x402Version: 2,
          resource: { url: "https://attacker.test/mcp" },
          accepts: [{
            scheme: "exact",
            network: "eip155:8453",
            asset: baseUsdc,
            amount: "125000",
            payTo: x402Terms.accepted.payTo,
          }],
        }),
      },
    }),
    x402Required({ payTo: "0x0000000000000000000000000000000000000000" }),
  ]) {
    let signCount = 0;
    let requestCount = 0;
    const client = new StratigraphyClient("https://example.test/mcp", {
      maxPaymentMicroUsdc: 200_000,
      x402Wallet: async () => { signCount++; return x402Signature(); },
      fetcher: (async () => { requestCount++; return response; }) as typeof fetch,
    });
    await assert.rejects(client.listStratigraphy(), /resource URL|payTo/i);
    assert.equal(signCount, 0);
    assert.equal(requestCount, 1);
  }

  let transmitted = false;
  const client = new StratigraphyClient("https://example.test/mcp", {
    maxPaymentMicroUsdc: 200_000,
    x402Wallet: async () => x402Signature({
      payload: { authorization: { to: x402Terms.accepted.payTo, value: "125001" } },
    }),
    fetcher: (async () => {
      if (transmitted) return rpc({ structuredContent: { totalSnapshots: 0 } });
      transmitted = true;
      return x402Required();
    }) as typeof fetch,
  });
  await assert.rejects(client.listStratigraphy(), /does not match accepted x402 terms/);
  assert.equal(transmitted, true);
});

test("rejects zero-value requirements and mismatched signer terms or resource", async () => {
  let signCount = 0;
  const zeroAmountClient = new StratigraphyClient("https://example.test/mcp", {
    maxPaymentMicroUsdc: 200_000,
    x402Wallet: async () => { signCount++; return x402Signature(); },
    fetcher: (async () => x402Required({ amount: "0" })) as typeof fetch,
  });
  await assert.rejects(zeroAmountClient.listStratigraphy(), /non-zero payment/);
  assert.equal(signCount, 0);

  for (const signed of [
    x402Signature({ accepted: { maxTimeoutSeconds: 61 } }),
    x402Signature({ resource: { url: "https://attacker.test/mcp" } }),
    x402Signature({ payload: { signature: "" } }),
  ]) {
    let requests = 0;
    const client = new StratigraphyClient("https://example.test/mcp", {
      maxPaymentMicroUsdc: 200_000,
      x402Wallet: async () => signed,
      fetcher: (async () => { requests++; return x402Required(); }) as typeof fetch,
    });
    await assert.rejects(client.listStratigraphy(), /accepted terms|resource|without a signature/i);
    assert.equal(requests, 1);
  }
});

test("does not pay x402 without a configured wallet", async () => {
  let requests = 0;
  const client = new StratigraphyClient("https://example.test/mcp", {
    maxPaymentMicroUsdc: 200_000,
    fetcher: (async () => { requests++; return x402Required(); }) as typeof fetch,
  });
  await assert.rejects(client.getMeshStatus(), /configure an x402 agent signer/);
  assert.equal(requests, 1);
});

test("does not sign an x402 quote when settlement is unavailable", async () => {
  let signs = 0;
  let requests = 0;
  const client = new StratigraphyClient("https://example.test/mcp", {
    maxPaymentMicroUsdc: 200_000,
    x402Wallet: async () => { signs++; return x402Signature(); },
    fetcher: (async () => {
      requests++;
      return x402Required({ extra: { ...x402Terms.accepted.extra, settlementAvailable: false } });
    }) as typeof fetch,
  });
  await assert.rejects(client.getMeshStatus(), /settlement is unavailable/);
  assert.equal(signs, 0);
  assert.equal(requests, 1);
});

test("never requests a second x402 payment when the signed retry gets a 402", async () => {
  let signs = 0;
  let requests = 0;
  const client = new StratigraphyClient("https://example.test/mcp", {
    maxPaymentMicroUsdc: 200_000,
    x402Wallet: async () => { signs++; return x402Signature(); },
    fetcher: (async () => { requests++; return x402Required(); }) as typeof fetch,
  });
  await assert.rejects(client.listStratigraphy(), /not paying again/);
  assert.equal(signs, 1);
  assert.equal(requests, 2);
});

test("surfaces tool and JSON-RPC errors", async () => {
  const failed = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    undefined,
    (async () => rpc({ isError: true, content: [{ type: "text", text: "failed" }] })) as typeof fetch,
  );
  await assert.rejects(failed.getMeshStatus(), /failed/);
  const invalid = new BitcoinStratigraphyClient(
    "https://example.test/mcp",
    undefined,
    (async () => new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" },
    }), { status: 200 })) as typeof fetch,
  );
  await assert.rejects(invalid.getMeshStatus(), /MCP -32602/);
});