import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DEFAULT_ENDPOINT, DiagnosticError, parseL402Challenge,
  requestChallenge, verifyPayment, promptForPreimage,
} from "../test_l402_plumbing.js";

const preimage = "ab".repeat(32); // Synthetic proof, never a real payment credential.
const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const header = 'L402 macaroon="synthetic-macaroon", invoice="lnbc1syntheticinvoice"';
const challenge = {
  url: DEFAULT_ENDPOINT, macaroon: "synthetic-macaroon",
  invoice: "lnbc1syntheticinvoice", paymentHash,
};

test("diagnostic parses either quoted L402 field order and rejects malformed or duplicate fields", () => {
  assert.equal(parseL402Challenge(header).macaroon, challenge.macaroon);
  assert.equal(parseL402Challenge('l402 INVOICE="lnbc1syntheticinvoice", MACAROON="synthetic-macaroon"').invoice, challenge.invoice);
  for (const invalid of [
    null, "Bearer abc", 'L402 macaroon="a"', `${header},`,
    `${header}, macaroon="duplicate"`, `${header}\r\ninjected: value`,
  ]) assert.throws(() => parseL402Challenge(invalid), DiagnosticError);
});

test("diagnostic issues one direct unauthenticated GET and extracts the 402 quote", async () => {
  let calls = 0;
  const result = await requestChallenge(DEFAULT_ENDPOINT, {
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, DEFAULT_ENDPOINT);
      assert.equal(options.method, "GET");
      assert.equal(new Headers(options.headers).has("authorization"), false);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      return Response.json({
        macaroon: challenge.macaroon, invoice: challenge.invoice,
        payment_hash: paymentHash, amount_sats: 9,
      }, { status: 402, headers: { "WWW-Authenticate": header } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.invoice, challenge.invoice);
  assert.equal(result.paymentHash, paymentHash);
  assert.equal(result.amountSats, 9);
});

test("diagnostic reports non-402 responses and rejects inconsistent quotes", async () => {
  await assert.rejects(requestChallenge(DEFAULT_ENDPOINT, {
    fetchImpl: async () => new Response("unprotected", { status: 200 }),
  }), /Expected HTTP 402/);
  await assert.rejects(requestChallenge(DEFAULT_ENDPOINT, {
    fetchImpl: async () => Response.json({ invoice: "different" }, {
      status: 402, headers: { "WWW-Authenticate": header },
    }),
  }), /differs/);
});

test("manual redemption reuses the exact URL and macaroon, redacting echoed proof", async () => {
  const result = await verifyPayment(challenge, preimage, {
    fetchImpl: async (url, options) => {
      assert.equal(url, DEFAULT_ENDPOINT);
      assert.equal(new Headers(options.headers).get("authorization"), `L402 ${challenge.macaroon}:${preimage}`);
      assert.equal(options.redirect, "error");
      return Response.json({ data: ["synthetic record"], unexpectedEcho: preimage });
    },
  });
  assert.equal(result.unlocked, true);
  assert.match(result.payload, /synthetic record/);
  assert.equal(result.payload.includes(preimage), false);
});

test("rejected proof never triggers a second request or an automatic payment", async () => {
  let calls = 0;
  const result = await verifyPayment(challenge, preimage, {
    fetchImpl: async () => { calls++; return Response.json({ error: "rejected" }, { status: 402 }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.unlocked, false);
});

test("invalid proof, wrong invoice hash and insecure endpoints fail before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("Must not reach network."); };
  await assert.rejects(verifyPayment(challenge, "not-a-preimage", { fetchImpl }), DiagnosticError);
  await assert.rejects(verifyPayment(challenge, "cd".repeat(32), { fetchImpl }), /does not match/);
  await assert.rejects(requestChallenge("http://example.test/path", { fetchImpl }), /HTTPS/);
  await assert.rejects(requestChallenge("https://example.test/?preimage=credential", { fetchImpl }), /credential/);
  assert.equal(calls, 0);
});

test("preimage input requires a local interactive terminal, never an echoed chat or CLI argument", () => {
  assert.throws(() => promptForPreimage({ isTTY: false }), /interactive terminal/);
});
