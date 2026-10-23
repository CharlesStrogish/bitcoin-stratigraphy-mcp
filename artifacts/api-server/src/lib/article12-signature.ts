import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Sign final JSON wire fields only; no payment preimage or issuer-selected trust key. */
export function signArticle12Receipt(
  receipt: Record<string, unknown>, privateKey: KeyObject,
): Record<string, unknown> {
  const { issuer_attestation: _oldSignature, ...unsigned } = receipt;
  const payload = JSON.parse(JSON.stringify(unsigned)) as Record<string, unknown>;
  if (!/^(?:[0-9a-f]{192}|[0-9a-f]{256}|[0-9a-f]{320})$/.test(String(payload.leaf_preimage))) {
    throw new Error("Offline receipt signing requires the exact Merkle leaf preimage");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 issuer key required");
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return {
    ...payload,
    issuer_attestation: {
      version: "article12-ed25519-v1",
      algorithm: "Ed25519",
      key_id: createHash("sha256").update(der).digest("hex"),
      signature: sign(null, Buffer.from(
        "bitcoin-stratigraphy/article12/v1\n" + canonical(payload), "utf8",
      ), privateKey).toString("base64"),
    },
  };
}
