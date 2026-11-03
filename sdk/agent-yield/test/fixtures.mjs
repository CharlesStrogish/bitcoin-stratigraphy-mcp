// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash } from "node:crypto";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

// Public synthetic fixtures. No network, wallet credentials or mainnet payments.
export const preimage = "01".repeat(32);
export const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const wordsFor = number => {
  const result = [];
  do { result.unshift(number % 32); number = Math.floor(number / 32); } while (number);
  return result;
};
const tag = (type, words) => [type, words.length >> 5, words.length % 32, ...words];
export function invoice(amount = 100_000n, paymentHash = hash) {
  const key = new Uint8Array(32).fill(3);
  const prefix = `lnbc${amount * 10n}p`;
  const words = [
    ...wordsFor(Math.floor(Date.now() / 1000)).reverse().concat(Array(7).fill(0)).slice(0, 7).reverse(),
    ...tag(1, bech32.toWords(Buffer.from(paymentHash, "hex"))),
    ...tag(13, bech32.toWords(Buffer.from("Synthetic SDK test"))),
    ...tag(6, wordsFor(3600)),
    ...tag(19, bech32.toWords(secp256k1.getPublicKey(key, true))),
  ];
  const bits = words.map(word => word.toString(2).padStart(5, "0")).join("");
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  const bytes = Uint8Array.from(padded.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const digest = createHash("sha256").update(prefix).update(bytes).digest();
  const signed = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
  return bech32.encode(prefix, [
    ...words, ...bech32.toWords(Uint8Array.from([...signed.slice(1), signed[0]])),
  ], 4096);
}
export const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });
