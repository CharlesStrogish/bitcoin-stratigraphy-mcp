import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto";
import { loadToolIntegrityKey } from "./tool-integrity";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A dedicated receipt key may rotate without rotating MCP integrity/webhook keys.
 * No key is trusted merely because the issuer publishes it. Auditors retain
 * current and historical SPKI pins through their independent trust channel.
 */
export function loadArticle12IssuerKey(): KeyObject {
  return process.env.ARTICLE12_ISSUER_PRIVATE_KEY === undefined
    ? loadToolIntegrityKey()
    : loadToolIntegrityKey({
      TOOL_INTEGRITY_PRIVATE_KEY: process.env.ARTICLE12_ISSUER_PRIVATE_KEY,
    });
}

export function issuerKeyId(privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 issuer key required");
  return createHash("sha256").update(
    createPublicKey(privateKey).export({ type: "spki", format: "der" }),
  ).digest("hex");
}

export function signIssuerPayload(
  payload: Record<string, unknown>, privateKey: KeyObject,
  version: string, domain: string,
): Record<string, unknown> {
  return {
    ...payload,
    issuer_attestation: {
      version, algorithm: "Ed25519", key_id: issuerKeyId(privateKey),
      signature: sign(null, Buffer.from(domain + canonical(payload), "utf8"), privateKey).toString("base64"),
    },
  };
}

/** Sign final JSON wire fields only; no payment preimage or issuer-selected trust key. */
export function signArticle12Receipt(
  receipt: Record<string, unknown>, privateKey: KeyObject,
): Record<string, unknown> {
  const { issuer_attestation: _oldSignature, ...unsigned } = receipt;
  const payload = JSON.parse(JSON.stringify({
    ...unsigned, issuer_key_id: issuerKeyId(privateKey),
    issued_at: new Date().toISOString(),
  })) as Record<string, unknown>;
  if (!/^(?:[0-9a-f]{192}|[0-9a-f]{256}|[0-9a-f]{320})$/.test(String(payload.leaf_preimage))) {
    throw new Error("Offline receipt signing requires the exact Merkle leaf preimage");
  }
  return signIssuerPayload(payload, privateKey, "article12-ed25519-v1",
    "bitcoin-stratigraphy/article12/v1\n");
}
