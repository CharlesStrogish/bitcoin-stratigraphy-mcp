import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { withFiduciaryYield } from "@bitcoinstratigraphy/agent-yield";
import { BUDGET, MCP_URL } from "../../config.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const toWords = (number) => {
  const words = [];
  do { words.unshift(number % 32); number = Math.floor(number / 32); } while (number);
  return words;
};
const tag = (type, words) => [type, Math.floor(words.length / 32), words.length % 32, ...words];

// Synthetic BOLT11s signed with a fixture key. All requests and wallet operations
// are intercepted below; these invoices are never broadcast to any network.
function invoice(sats, paymentHash) {
  const key = new Uint8Array(32).fill(3);
  const prefix = `lnbc${BigInt(sats) * 10000n}p`;
  const words = [
    ...toWords(Math.floor(Date.now() / 1000)).reverse().concat(Array(7).fill(0)).slice(0, 7).reverse(),
    ...tag(1, bech32.toWords(Buffer.from(paymentHash, "hex"))),
    ...tag(13, bech32.toWords(Buffer.from("Offline fixture read purchase"))),
    ...tag(6, toWords(3600)),
    ...tag(19, bech32.toWords(secp256k1.getPublicKey(key, true))),
  ];
  const bits = words.map((word) => word.toString(2).padStart(5, "0")).join("");
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  const bytes = Uint8Array.from(padded.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const digest = createHash("sha256").update(prefix).update(bytes).digest();
  const recovered = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const signature = Uint8Array.from([...recovered.slice(1), recovered[0]]);
  return bech32.encode(prefix, [...words, ...bech32.toWords(signature)], 4096);
}

export async function paidServer(t, options = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "fiduciary-paid-template-"));
  let connected;
  t.after(async () => {
    // Yield/recovery bookkeeping can still be writing after the response returns.
    await connected?.fiduciary.drain();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const keys = generateKeyPairSync("ed25519"); // Disposable in-memory server identity.
  const serverPublicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const quotes = new Map();
  const events = [];
  const payments = [];
  const prices = options.prices ?? [7, 13, 19];
  function signed(rpc, body) {
    const result = options.applicationError ? { isError: true, content: [] } : {
      structuredContent: { source: "offline fixture", date: "2026-11-08", height: 900000 },
      content: [{ type: "text", text: "Offline data." }],
    };
    const text = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
    const bytes = Buffer.from(`bitcoinstratigraphy/payload/v1\n${hash(body)}\n${text}`);
    const signature = sign(null, bytes, keys.privateKey).toString("base64");
    return new Response(options.tamper ? text.replace("offline fixture", "tampered source") : text, {
      headers: { "Content-Type": "application/json",
        ...(options.unsigned ? {} : { "X-Stratigraphy-Signature": `v1,${signature}` }) },
    });
  }
  connected = await withFiduciaryYield({
    framework: "langchain", tools: [],
    fiduciary: {
      ...BUDGET, ...options.budget, stateDirectory, serverPublicKey, mcpUrl: MCP_URL,
      onError: () => {},
      wallet: {
        async payInvoice(text) {
          const quote = [...quotes.values()].find((entry) => entry.invoice === text);
          assert.ok(quote, "Only a server-issued fixture invoice may reach the wallet.");
          payments.push(quote.amount_sats);
          events.push("wallet");
          if (options.walletError) throw new Error("private-wallet-credential-must-not-escape");
          return { preimage: options.badPreimage ? "ff".repeat(32) : quote.preimage, fees_paid: 0 };
        },
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, MCP_URL, "Tests must never contact any other endpoint.");
        const body = await request.text();
        const rpc = JSON.parse(body);
        if (rpc.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [
            { name: "stratigraphy.list", description: "Synthetic catalog.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false } },
            { name: "stratigraphy.get", description: "Synthetic paid read.",
              inputSchema: { type: "object", additionalProperties: false, required: ["days", "limit"],
                properties: { days: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } } } },
          ] } });
        }
        assert.equal(rpc.method, "tools/call");
        if (rpc.params.name === "stratigraphy.list") return signed(rpc, body);
        assert.equal(rpc.params.name, "stratigraphy.get");
        assert.deepEqual(rpc.params.arguments, { days: 1, limit: 1 });
        if (options.free) return signed(rpc, body);
        let quote = quotes.get(rpc.id);
        if (!quote) {
          const index = quotes.size;
          const amount = prices[index % prices.length];
          const preimage = Buffer.alloc(32, index + 1).toString("hex");
          const paymentHash = hash(Buffer.from(preimage, "hex"));
          quote = {
            preimage, payment_hash: paymentHash, amount_sats: amount,
            invoice: invoice(amount, paymentHash), macaroon: `offline-macaroon-${rpc.id}`,
          };
          if (options.reuseInvoice && quotes.size) quote = quotes.values().next().value;
          quotes.set(rpc.id, quote);
          events.push("quote");
        }
        if (!request.headers.has("authorization")) {
          const { preimage: _private, ...publicQuote } = quote;
          return Response.json(publicQuote, {
            status: 402,
            headers: { "WWW-Authenticate": `L402 macaroon="${quote.macaroon}", invoice="${quote.invoice}"` },
          });
        }
        assert.equal(request.headers.get("authorization"), `L402 ${quote.macaroon}:${quote.preimage}`);
        events.push("paid-result");
        options.afterPayment?.();
        return signed(rpc, body);
      },
    },
  });
  return { connected, events, payments, quotes, stateDirectory };
}
