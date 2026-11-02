import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { BitcoinStratigraphyRouter } from "../index.js";
import { decodeInvoice, sha256 } from "../lib/invoice.js";

const ENGINE = "https://bitcoinstratigraphy.com";
const preimage = "01".repeat(32);
const paymentHash = sha256(Buffer.from(preimage, "hex"));
const receivingHash = "ab".repeat(32);
const requestBody = JSON.stringify({
  jsonrpc: "2.0", id: 7, method: "tools/call",
  params: { name: "stratigraphy.get", arguments: { target: "latest" } },
});
const key = new Uint8Array(32).fill(3); // Synthetic fixture key; never a real wallet.
const toWords = number => {
  const words = [];
  do { words.unshift(number % 32); number = Math.floor(number / 32); } while (number);
  return words;
};
const tag = (type, words) => [type, Math.floor(words.length / 32), words.length % 32, ...words];

function invoice({ amount = 100000n, hash = paymentHash, expires = 3600, created = Math.floor(Date.now() / 1000) } = {}) {
  const hrp = `lnbc${amount * 10n}p`;
  const words = [
    ...toWords(created).reverse().concat(Array(7).fill(0)).slice(0, 7).reverse(),
    ...tag(1, bech32.toWords(Buffer.from(hash, "hex"))),
    ...tag(13, bech32.toWords(Buffer.from("Mock data purchase"))),
    ...tag(6, toWords(expires)),
    ...tag(19, bech32.toWords(secp256k1.getPublicKey(key, true))),
  ];
  // Independent bit-string packing for BOLT11's signed data.
  const bits = words.map(word => word.toString(2).padStart(5, "0")).join("");
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  const bytes = Uint8Array.from(padded.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const digest = createHash("sha256").update(hrp).update(bytes).digest();
  const recovered = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  const signature = Uint8Array.from([...recovered.slice(1), recovered[0]]);
  return bech32.encode(hrp, [...words, ...bech32.toWords(signature)], 4096);
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fiduciary-router-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const challengeInvoice = options.invoice ?? invoice();
  const receivingInvoice = invoice({ amount: 21000n, hash: receivingHash });
  const calls = [], events = [], errors = [];
  let payments = 0, receivingInvoices = 0, paidRetries = 0;
  const wallet = {
    async payInvoice(text) {
      payments++;
      assert.equal(text, challengeInvoice);
      if (options.paymentError) throw new Error("private-credential-must-not-escape");
      if (options.payGate) await options.payGate;
      return { preimage: options.badPreimage ? "02".repeat(32) : preimage,
        fees_paid: options.highFees ? 11000 : 1000 };
    },
    async makeInvoice(amount) {
      receivingInvoices++;
      assert.equal(amount, 21000);
      if (options.invoiceError) throw new Error("Wallet error");
      return { invoice: options.wrongReceiving ? challengeInvoice : receivingInvoice };
    },
  };
  const fetch = async request => {
    const body = await request.clone().text();
    calls.push({ url: request.url, method: request.method, headers: request.headers, body });
    assert.equal(request.redirect, "error");
    if (request.url === `${ENGINE}/api/claim-yield`) {
      assert.deepEqual(JSON.parse(body), {
        macaroons: ["mock-macaroon"], bolt11_invoice: receivingInvoice,
      });
      if (options.claimError) throw new Error("Private provider detail");
      return json({ status: options.claimPending ? "PENDING" : "SETTLED",
        payment_sent: options.claimPending ? null : true, claim_id: "mock-claim" },
      options.claimPending ? 202 : 200);
    }
    assert.equal(body, requestBody);
    if (options.free) return json({ result: { free: true } });
    if (request.headers.get("authorization")?.startsWith("L402 ")) {
      paidRetries++;
      if (options.repeated402) return challenge();
      assert.equal(request.headers.get("authorization"), `L402 mock-macaroon:${preimage}`);
      if (options.sse) {
        return new Response(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0", id: 7, ...(options.applicationError ? { error: { code: -1 } } : { result: { content: [] } }),
        })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      }
      return json(options.applicationError ? { jsonrpc: "2.0", id: 7, error: { code: -1 } } :
        { jsonrpc: "2.0", id: 7, result: { content: [] } });
    }
    return challenge();
  };
  function challenge() {
    if (options.admission) return json({ error: "INVOICE_COMPUTE_REQUIRED" }, 402);
    return json({
      macaroon: "mock-macaroon", invoice: challengeInvoice,
      payment_hash: paymentHash, amount_sats: options.badQuote ? 999 : 100,
    }, 402, { "WWW-Authenticate": options.badHeader ??
      `L402 macaroon="mock-macaroon", invoice="${challengeInvoice}"` });
  }
  const router = new BitcoinStratigraphyRouter({
    wallet, fetch, maxPaymentSats: options.limit ?? 1000,
    maxTotalSats: options.total ?? 10000, stateDirectory: directory,
    onYieldClaim: event => events.push(event), onError: event => errors.push(event),
    ...options.routerOptions,
  });
  const run = (origin = ENGINE) => router.fetch(`${origin}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Scope": "unchanged" }, body: requestBody,
  });
  return { router, run, calls, events, errors, directory, wallet, fetch,
    counts: () => ({ payments, receivingInvoices, paidRetries }),
    state: async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8")) };
}

test("verifies a signed synthetic BOLT11 and rejects tampered signatures", () => {
  const text = invoice();
  const decoded = decodeInvoice(text);
  assert.equal(decoded.amountMsats, 100000n);
  assert.equal(decoded.paymentHash, paymentHash);
  const { prefix, words } = bech32.decode(text, 4096);
  words[words.length - 104] ^= 1;
  assert.throws(() => decodeInvoice(bech32.encode(prefix, words, 4096)));
});

test("402 → mocked NWC payment → identical authorized retry → background 21% claim", async t => {
  const ctx = await setup(t);
  const response = await ctx.run();
  assert.equal(response.status, 200);
  await ctx.router.drain();
  assert.equal((await response.json()).id, 7);
  assert.deepEqual(ctx.counts(), { payments: 1, receivingInvoices: 1, paidRetries: 1 });
  assert.equal(ctx.calls[1].body, ctx.calls[0].body);
  assert.equal(ctx.calls[1].headers.get("x-scope"), "unchanged");
  assert.deepEqual(ctx.events, [{ status: "settled", claimId: "mock-claim", amountMsats: "21000" }]);
  assert.equal((await ctx.state()).invoices[paymentHash].claim.status, "settled");
  assert.equal((await stat(join(ctx.directory, "state.json"))).mode & 0o777, 0o600);
});

test("free requests and untrusted origins do not spend", async t => {
  const free = await setup(t, { free: true });
  assert.equal((await free.run()).status, 200);
  assert.equal(free.counts().payments, 0);
  const other = await setup(t);
  assert.equal((await other.run("https://example.com")).status, 402);
  assert.equal(other.counts().payments, 0);
});

test("invoice admission without L402 is passed through, not paid", async t => {
  const ctx = await setup(t, { admission: true });
  assert.equal((await ctx.run()).status, 402);
  assert.equal(ctx.counts().payments, 0);
});

test("malformed headers, conflicting quotes, expired invoices and budget failures never pay", async t => {
  for (const options of [
    { badHeader: 'L402 macaroon="x", invoice="x", invoice="y"' },
    { badQuote: true }, { invoice: invoice({ created: 1000, expires: 1 }) },
    { limit: 50 }, { total: 100 },
  ]) {
    const ctx = await setup(t, options);
    await assert.rejects(ctx.run());
    assert.equal(ctx.counts().payments, 0);
  }
});

test("bad preimages never authorize retry, and uncertain payments cannot be repaid", async t => {
  for (const options of [{ badPreimage: true }, { paymentError: true }]) {
    const ctx = await setup(t, options);
    await assert.rejects(ctx.run(), /PAYMENT/);
    await assert.rejects(ctx.run(), /PENDING/);
    assert.equal(ctx.counts().payments, 1);
    assert.equal(ctx.counts().paidRetries, 0);
    assert.equal((await ctx.state()).invoices[paymentHash].status, "pending");
  }
});

test("a repeated 402 and application-level failures do not cause yield claims", async t => {
  for (const options of [{ repeated402: true }, { applicationError: true }, { sse: true, applicationError: true }]) {
    const ctx = await setup(t, options);
    await ctx.run();
    await ctx.router.drain();
    assert.equal(ctx.counts().payments, 1);
    assert.equal(ctx.counts().receivingInvoices, 0);
  }
});

test("claim errors preserve the paid response and exact recovery body", async t => {
  const ctx = await setup(t, { claimError: true });
  const result = await ctx.run();
  await ctx.router.drain();
  assert.equal(result.status, 200);
  assert.equal(ctx.errors[0].code, "YIELD_CLAIM_REQUIRES_RECOVERY");
  assert.equal((await ctx.state()).invoices[paymentHash].claim.status, "prepared");
  await assert.rejects(ctx.router.recoverClaim(paymentHash));
  assert.equal(ctx.calls.at(-1).body, ctx.calls.at(-2).body);
  assert.equal(ctx.counts().payments, 1);
});

test("pending claims remain pending and repeated calls reuse stored payment proofs", async t => {
  const ctx = await setup(t, { claimPending: true });
  await ctx.run();
  await ctx.router.drain();
  assert.equal(ctx.events[0].status, "pending");
  await ctx.run();
  await ctx.router.drain();
  assert.equal(ctx.counts().payments, 1);
  assert.equal(ctx.counts().receivingInvoices, 1);
  assert.equal(ctx.calls.filter(call => call.url.endsWith("/api/claim-yield")).length, 1);
  await ctx.router.recoverClaim(paymentHash);
  assert.equal(ctx.counts().payments, 1);
});

test("a valid matching SSE result is observed asynchronously and remains readable by the caller", async t => {
  const ctx = await setup(t, { sse: true });
  const response = await ctx.run();
  assert.match(await response.text(), /data:/);
  await ctx.router.drain();
  assert.equal(ctx.events[0].status, "settled");
});

test("wrong receiving amount and wallet invoice errors never submit a claim", async t => {
  for (const options of [{ wrongReceiving: true }, { invoiceError: true }]) {
    const ctx = await setup(t, options);
    assert.equal((await ctx.run()).status, 200);
    await ctx.router.drain();
    assert.equal(ctx.errors[0].code, "YIELD_CLAIM_REQUIRES_RECOVERY");
    assert.equal(ctx.calls.length, 2);
  }
});

test("concurrent workers sharing state cannot double-pay", async t => {
  let release;
  const payGate = new Promise(resolve => { release = resolve; });
  const ctx = await setup(t, { payGate });
  const first = ctx.run();
  // Wait until the first wallet call has acquired its durable reservation.
  while (!ctx.counts().payments) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(ctx.run(), /PENDING/);
  release();
  await first;
  await ctx.router.drain();
  assert.equal(ctx.counts().payments, 1);
});

test("constructor requires explicit spending limits and never reads real environment wallet secrets", () => {
  assert.throws(() => new BitcoinStratigraphyRouter(), /LIMIT/);
  assert.throws(() => new BitcoinStratigraphyRouter({
    nwcUri: "not-a-wallet", maxPaymentSats: 100, maxTotalSats: 100,
  }), /INVALID_NWC_URI/);
});

test("a restarted router reuses durable proofs instead of paying again", async t => {
  const ctx = await setup(t);
  await ctx.run();
  await ctx.router.drain();
  const restarted = new BitcoinStratigraphyRouter({
    wallet: ctx.wallet, fetch: ctx.fetch, stateDirectory: ctx.directory,
    maxPaymentSats: 1000, maxTotalSats: 10000,
  });
  await restarted.fetch(`${ENGINE}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Scope": "unchanged" }, body: requestBody,
  });
  await restarted.drain();
  assert.equal(ctx.counts().payments, 1);
  assert.equal(ctx.counts().receivingInvoices, 1);
  assert.equal(ctx.counts().paidRetries, 2);
});

test("excess wallet fees block future spending without losing the paid data", async t => {
  const ctx = await setup(t, { highFees: true });
  assert.equal((await ctx.run()).status, 200);
  await ctx.router.drain();
  assert.equal((await ctx.state()).blocked, true);
  assert.equal(ctx.events[0].status, "settled");
});
