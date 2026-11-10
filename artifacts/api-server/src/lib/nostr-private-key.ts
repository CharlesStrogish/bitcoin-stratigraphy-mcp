import { nip19 } from "nostr-tools";

/** Decode operator-provided keys without including their contents in errors. */
export function parsePrivateKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  if (/^nsec1/i.test(trimmed)) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "nsec" && decoded.data.length === 32) return decoded.data;
    } catch {
      // Decoder errors may contain the supplied secret. Never propagate them.
    }
  }
  throw new Error("Nostr private key must be a valid 64-character hex key or nsec1 bech32 key");
}

export function privateKeyHex(value: string): string {
  return Buffer.from(parsePrivateKey(value)).toString("hex");
}
