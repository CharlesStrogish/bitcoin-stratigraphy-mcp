import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import { base58, bech32 } from "@scure/base";

export class SettlementKeyError extends Error {
  readonly status = 503;
  constructor(code: "waiver_settlement_key_unconfigured" | "waiver_settlement_key_invalid") {
    super(code);
  }
}

/** Public account key only. Validate the serialized key before any HD parser. */
export function btcAddressDeriver(value: string | undefined) {
  if (!value) throw new SettlementKeyError("waiver_settlement_key_unconfigured");
  try {
    if (!/^zpub[1-9A-HJ-NP-Za-km-z]{107}$/.test(value)) throw new Error();
    const bytes = Buffer.from(base58.decode(value));
    const payload = bytes.subarray(0, 78);
    const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest();
    if (bytes.length !== 82 || !bytes.subarray(78).equals(checksum.subarray(0, 4)) ||
        payload.readUInt32BE(0) !== 0x04b24746 || payload[4] !== 3 ||
        payload.readUInt32BE(9) < 0x80000000 || ![2, 3].includes(payload[45]!)) throw new Error();
    const account = HDKey.fromExtendedKey(value, { public: 0x04b24746, private: 0x04b2430c });
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
  try {
    log.info(`WAIVER_BTC_ZPUB active (verify index 0 matches cold storage: ${btcAddressDeriver(value)(0)})`);
  } catch {
    log.error("waiver_settlement_key_invalid: waiver quote creation disabled");
  }
}
