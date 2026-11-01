import { bech32 } from "@scure/base";

export type YieldWithdrawalInvoice = {
  amountMsats: bigint;
  paymentHash: string;
  expiresAt: number;
};

/** Encoding, amount, required tags and expiry validation; no outbound wallet call. */
export function parseYieldWithdrawalInvoice(invoice: string, now = Date.now()): YieldWithdrawalInvoice {
  const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, 4096);
  const amount = /^lnbc([1-9]\d*)([munp]?)$/.exec(prefix);
  if (!amount || words.length < 7 + 3 + 52 + 104) throw new Error("Invalid fixed-amount mainnet BOLT11 invoice");
  const scales: Record<string, bigint> = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };
  const value = BigInt(amount[1]!);
  const amountMsats = amount[2] === "p" ? value / 10n : value * scales[amount[2]!]!;
  if ((amount[2] === "p" && value % 10n !== 0n) ||
      amountMsats <= 0n || amountMsats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invoice amount must be an exact positive safe millisatoshi amount");
  }
  const integer = (part: number[]) => part.reduce((sum, word) => sum * 32 + word, 0);
  const timestamp = integer(words.slice(0, 7));
  let expiry = 3600;
  let sawExpiry = false;
  let paymentHash: string | undefined;
  const end = words.length - 104; // The final 65-byte recoverable signature.
  for (let cursor = 7; cursor < end;) {
    if (cursor + 3 > end) throw new Error("Truncated invoice tag");
    const tag = words[cursor]!;
    const length = words[cursor + 1]! * 32 + words[cursor + 2]!;
    cursor += 3;
    if (cursor + length > end) throw new Error("Truncated invoice tag data");
    const data = words.slice(cursor, cursor + length);
    if (tag === 1) {
      if (paymentHash || length !== 52) throw new Error("Invalid payment hash");
      paymentHash = Buffer.from(bech32.fromWords(data)).toString("hex");
      if (paymentHash.length !== 64) throw new Error("Invalid payment hash");
    }
    if (tag === 6) {
      if (sawExpiry || !length || length > 10) throw new Error("Invalid invoice expiry");
      expiry = integer(data);
      sawExpiry = true;
    }
    cursor += length;
  }
  const expiresAt = (timestamp + expiry) * 1000;
  if (!paymentHash || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("Missing payment hash or expired invoice");
  }
  return { amountMsats, paymentHash, expiresAt };
}
