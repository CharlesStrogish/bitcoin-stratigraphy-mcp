import { createHash } from "node:crypto";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const integer = words => words.reduce((value, word) => value * 32 + word, 0);

// BOLT11 signs the HRP followed by 5-bit data packed into padded octets.
function paddedBytes(words) {
  let accumulator = 0, bits = 0;
  const result = [];
  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((accumulator >>> bits) & 255);
    }
  }
  if (bits) result.push((accumulator << (8 - bits)) & 255);
  return Buffer.from(result);
}

export function decodeInvoice(text) {
  if (typeof text !== "string" || text.length > 4096) throw new Error("INVALID_INVOICE");
  const { prefix, words } = bech32.decode(text, 4096);
  const amount = /^lnbc([1-9]\d*)([munp]?)$/.exec(prefix);
  if (!amount || words.length < 166) throw new Error("FIXED_MAINNET_INVOICE_REQUIRED");
  const value = BigInt(amount[1]);
  const scales = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };
  if (amount[2] === "p" && value % 10n) throw new Error("INVALID_MSAT_AMOUNT");
  const amountMsats = amount[2] === "p" ? value / 10n : value * scales[amount[2]];
  if (amountMsats <= 0n || amountMsats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("INVALID_AMOUNT");
  const end = words.length - 104;
  let paymentHash, payee, expiry = 3600, descriptionCount = 0;
  const unique = new Set();
  for (let cursor = 7; cursor < end;) {
    if (cursor + 3 > end) throw new Error("INVALID_INVOICE_TAG");
    const tag = words[cursor++], length = words[cursor++] * 32 + words[cursor++];
    if (cursor + length > end) throw new Error("INVALID_INVOICE_TAG");
    const data = words.slice(cursor, cursor + length);
    cursor += length;
    if ([1, 6, 19, 13, 23].includes(tag)) {
      if (unique.has(tag)) throw new Error("DUPLICATE_INVOICE_TAG");
      unique.add(tag);
    }
    if (tag === 1) {
      if (length !== 52) throw new Error("INVALID_PAYMENT_HASH");
      paymentHash = Buffer.from(bech32.fromWords(data)).toString("hex");
    }
    if (tag === 6) {
      if (!length || length > 10) throw new Error("INVALID_EXPIRY");
      expiry = integer(data);
    }
    if (tag === 19) payee = Buffer.from(bech32.fromWords(data));
    if (tag === 13 || tag === 23) {
      if (tag === 23 && bech32.fromWords(data).length !== 32) throw new Error("INVALID_DESCRIPTION_HASH");
      descriptionCount++;
    }
  }
  const expiresAt = (integer(words.slice(0, 7)) + expiry) * 1000;
  if (!paymentHash || descriptionCount !== 1 || !Number.isSafeInteger(expiresAt)) throw new Error("INVALID_INVOICE");
  const signature = Buffer.from(bech32.fromWords(words.slice(end)));
  if (signature.length !== 65 || signature[64] > 3) throw new Error("INVALID_SIGNATURE");
  const message = createHash("sha256").update(prefix).update(paddedBytes(words.slice(0, end))).digest();
  const recovered = secp256k1.Signature.fromBytes(signature.subarray(0, 64))
    .addRecoveryBit(signature[64]).recoverPublicKey(message).toBytes(true);
  if (payee && !payee.equals(Buffer.from(recovered))) throw new Error("WRONG_PAYEE");
  if (!secp256k1.verify(signature.subarray(0, 64), message, recovered, { prehash: false, lowS: false })) {
    throw new Error("INVALID_SIGNATURE");
  }
  return { amountMsats, paymentHash, expiresAt };
}

export function verifyPreimage(preimage, paymentHash) {
  return typeof preimage === "string" && /^[0-9a-f]{64}$/i.test(preimage) &&
    sha256(Buffer.from(preimage, "hex")) === paymentHash;
}

export function parseChallenge(header) {
  if (!header || header.length > 24_000 || /[\x00-\x1f\x7f]/.test(header)) throw new Error("INVALID_L402_HEADER");
  const match = /^L402\s+macaroon="([^"\\]+)",\s*invoice="([^"\\]+)"$/i.exec(header);
  if (!match) throw new Error("UNSUPPORTED_L402_HEADER");
  return { macaroon: match[1], invoice: match[2] };
}
