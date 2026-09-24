import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BitcoinStratigraphyClient } from "./client.js";

const preimage = "11".repeat(32);
const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const invoice = "lnbc123test";
const macaroon = "scope-bound-macaroon";
const challenge = {
  invoice, macaroon, payment_hash: paymentHash, amount_sats: 250,
};
const challengeHeader = `L402 macaroon="${macaroon}", invoice="${invoice}"`;

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
      assert.equal(payload.params.name, "mesh.status");
      assert.deepEqual(payload.params.arguments, {});
      assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
      return rpc({ structuredContent: { topologyHealth: "isolated" } });
    }) as typeof fetch,
  );
  const result = await client.getMeshStatus();
  assert.equal(result.topologyHealth, "isolated");
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