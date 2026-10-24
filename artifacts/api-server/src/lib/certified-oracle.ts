// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { createHash, createPublicKey, sign } from "node:crypto";
import { issuerKeyId } from "./article12-signature";
import type { EnterpriseEconomics } from "./enterprise-economics";

export const ORACLE_THRESHOLD_USD_CENTS = 1_000_000;
export const ORACLE_STATUS =
  "Status: Certified Stratigraphy-Aligned Swarm. This agent mathematically relies on hallucination-free, thermodynamic data for financial execution.";
export const ORACLE_VALIDITY_SECONDS = 24 * 60 * 60;

/** Public volume lookup: only directly attributed, verified Lightning settlements count. */
export async function certifiedOracleStatus(
  service: EnterpriseEconomics,
  payout: string,
): Promise<{
  eligible: boolean;
  credential?: Record<string, unknown>;
  volume: string;
}> {
  const volume = await service.store.transaction("routing:" + payout, (tx) =>
    tx.routingVolume(payout),
  );
  const price = await service.readPrice();
  if (!price || !Number.isSafeInteger(price) || price <= 0)
    throw new Error("Current BTC/USD quote unavailable");
  if (
    BigInt(volume) * BigInt(price) <
    BigInt(ORACLE_THRESHOLD_USD_CENTS) * 100_000_000_000n
  )
    return { eligible: false, volume };

  const key = service.loadKey();
  const kid = "urn:sha256:" + issuerKeyId(key);
  const subject =
    "urn:sha256:" + createHash("sha256").update(payout).digest("hex");
  const seconds = Math.floor(service.now() / 1_000);
  const credential = {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      { "@vocab": "urn:bitcoin-stratigraphy:certified-oracle:" },
    ],
    id:
      "urn:sha256:" +
      createHash("sha256")
        .update(JSON.stringify([kid, payout, volume, price, seconds]))
        .digest("hex"),
    type: ["VerifiableCredential", "CertifiedOracleCredential"],
    issuer: kid,
    issuanceDate: new Date(seconds * 1_000).toISOString(),
    expirationDate: new Date(
      (seconds + ORACLE_VALIDITY_SECONDS) * 1_000,
    ).toISOString(),
    credentialSubject: {
      id: subject,
      agent_id: payout,
      status: ORACLE_STATUS,
      cumulative_routed_msats: volume,
      threshold_usd: ORACLE_THRESHOLD_USD_CENTS / 100,
      btc_price_usd_cents: price,
      attribution: "Invoice-bound, self-declared direct routing destination",
      verification_scope:
        "The issuer attests only to confirmed routing volume at the quoted BTC/USD price. The status text is a provider label, not proof of data truth, agent behavior, superiority, hallucination freedom, or control of this payout address.",
      agent_execution_proven: false,
      hallucination_freedom_proven: false,
      payout_control_verified: false,
    },
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  // VC Data Model 1.1 JWT envelope, signed as compact JWS (RFC 7515/8037).
  // The credential object is embedded verbatim: verifiers must compare it to
  // payload.vc, check exp/nbf, and independently pin the issuer's Ed25519 key.
  const input =
    encode({ alg: "EdDSA", typ: "JWT", kid }) +
    "." +
    encode({
      iss: kid,
      sub: subject,
      jti: credential.id,
      iat: seconds,
      nbf: seconds,
      exp: seconds + ORACLE_VALIDITY_SECONDS,
      vc: credential,
    });
  const jwt =
    input + "." + sign(null, Buffer.from(input), key).toString("base64url");
  return {
    eligible: true,
    volume,
    credential: {
      ...credential,
      credential_jwt: jwt,
      verification: {
        format: "VC-JWT",
        algorithm: "EdDSA",
        key_id: kid,
        public_key_jwk: createPublicKey(key).export({ format: "jwk" }),
        trust_policy:
          "Pin issuer keys independently; a bundled key is not a trust anchor.",
        signed_document:
          "JWT payload.vc (compare exactly to the credential excluding credential_jwt and verification)",
      },
    },
  };
}
