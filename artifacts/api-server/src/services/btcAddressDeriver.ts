import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import { base58, bech32 } from "@scure/base";

export class SettlementKeyError extends Error {
  readonly status = 503;
  constructor(code: "waiver_settlement_key_unconfigured" | "waiver_settlement_key_invalid") {
    super(code);
  }
}

/** Parse only the public account serialization; never derive a child or do I/O. */
function parseWaiverBtcZpub(value: string): HDKey {
  if (!/^zpub[1-9A-HJ-NP-Za-km-z]{107}$/.test(value)) throw new Error();
  const bytes = Buffer.from(base58.decode(value));
  const payload = bytes.subarray(0, 78);
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest();
  if (bytes.length !== 82 || !bytes.subarray(78).equals(checksum.subarray(0, 4)) ||
      payload.readUInt32BE(0) !== 0x04b24746 || payload[4] !== 3 ||
      payload.readUInt32BE(9) < 0x80000000 || ![2, 3].includes(payload[45]!)) throw new Error();
  const account = HDKey.fromExtendedKey(value, { public: 0x04b24746, private: 0x04b2430c });
  if (account.privateKey !== null || account.publicKey?.length !== 33 ||
      account.chainCode?.length !== 32) throw new Error();
  return account;
}

/** Informational configuration validation only: no child keys, addresses or I/O. */
export function isValidWaiverBtcZpub(raw?: string): boolean {
  if (typeof raw !== "string" || !raw) return false;
  try {
    parseWaiverBtcZpub(raw);
    return true;
  } catch {
    return false;
  }
}

/** Public account key only. Checkout retains the existing /0/index derivation. */
export function btcAddressDeriver(value: string | undefined) {
  if (!value) throw new SettlementKeyError("waiver_settlement_key_unconfigured");
  try {
    const account = parseWaiverBtcZpub(value);
    const external = account.deriveChild(0);
    if (account.privateKey !== null || external.index !== 0) throw new Error();
    return (index: number): string => {
      if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000)
        throw new SettlementKeyError("waiver_settlement_key_invalid");
      const child = external.deriveChild(index);
      // BIP32 libraries skip invalid children. Never silently map two indices to one address.
      if (child.index !== index || !child.pubKeyHash) throw new SettlementKeyError("waiver_settlement_key_invalid");
      return bech32.encode("bc", [0, ...bech32.toWords(child.pubKeyHash)]);
    };
  } catch {
    // Never propagate parser messages, the original value, or an Error.cause.
    throw new SettlementKeyError("waiver_settlement_key_invalid");
  }
}

export function logWaiverSettlementStatus(log: { info(message: string): void; error(message: string): void },
  value = process.env.WAIVER_BTC_ZPUB) {
  if (!value) return;
  if (isValidWaiverBtcZpub(value)) {
    log.info("Waiver settlement key configured");
  } else {
    log.error("waiver_settlement_key_invalid: waiver quote creation disabled");
  }
}
