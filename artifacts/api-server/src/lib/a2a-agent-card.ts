// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { issuerKeyId } from "./article12-signature";
import { jcs } from "./jcs";
import { CANONICAL_ORIGIN, canonicalUrl } from "./public-site";
import { MCP_SERVER_INFO } from "./mcp-stateless";

export const A2A_DISCOVERY_PATHS = [
  "/.well-known/agent-card.json",
  "/.well-known/jwks.json",
] as const;

export function isA2aDiscoveryPath(path: string): boolean {
  return A2A_DISCOVERY_PATHS.some(
    (candidate) => candidate === path.toLowerCase().replace(/\/$/, ""),
  );
}

/** Receive the SAME loaded key as integrity.json; never load/generate a new key.
 * The existing loader prefers dedicated PEM configuration, then persistent
 * session-secret derivation, then an owner-only local standalone/dev key.
 * Tests and navigation audits inject synthetic keys. No private JWK is exported.
 */
export function buildA2aDiscovery(privateKey: KeyObject) {
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  )
    throw new TypeError("A2A discovery requires an Ed25519 private key.");
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string" ||
    Buffer.from(publicJwk.x, "base64url").length !== 32 ||
    Object.hasOwn(publicJwk, "d")
  )
    throw new TypeError("A2A discovery requires a public Ed25519 OKP JWK.");
  const kid = issuerKeyId(privateKey);
  // Explicit public-field allowlist: never spread an exported key object.
  const jwks = {
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        use: "sig",
        alg: "EdDSA",
        kid,
        x: publicJwk.x,
      },
    ],
  };
  const unsignedCard = {
    name: "Bitcoin Stratigraphy",
    description:
      "Bitcoin L402 telemetry engine, OpenTimestamps notary, and tamper-evident AI audit hub for autonomous MCP swarms.",
    version: MCP_SERVER_INFO.version,
    provider: { organization: "Bitcoin Stratigraphy", url: CANONICAL_ORIGIN },
    documentationUrl: canonicalUrl("/docs"),
    supportedInterfaces: [
      {
        url: canonicalUrl("/mcp"),
        protocolBinding:
          "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    securitySchemes: {
      l402: {
        httpAuthSecurityScheme: {
          scheme: "L402",
          description:
            "Bitcoin Lightning L402 capability macaroon and payment preimage (Authorization: L402 <macaroon>:<preimage>).",
        },
      },
    },
    skills: [
      {
        id: "bitcoin-state-grounding",
        name: "Bitcoin state grounding",
        description:
          "Ground Bitcoin chain, fee and mempool state with proof.ground and stratigraphy telemetry.",
        tags: ["bitcoin", "telemetry", "grounding"],
        examples: [
          "Ground the current Bitcoin chain state using proof.ground.",
        ],
      },
      {
        id: "opentimestamps-notarization",
        name: "OpenTimestamps notarization",
        description:
          "Generate cryptographic receipts and request or verify OpenTimestamps (.ots) Bitcoin anchoring with proof.notarize and proof.verify.",
        tags: ["bitcoin", "opentimestamps", "receipts"],
        examples: [
          "Notarize an audit digest with proof.notarize, then check its receipt with proof.verify.",
        ],
      },
      {
        id: "l402-capability-delegation",
        name: "L402 capability delegation",
        description:
          "Attenuate L402 macaroons offline with proof.attenuate and audit Ed25519-signed revocation snapshots.",
        tags: ["l402", "macaroons", "revocation"],
        examples: [
          "Delegate a narrower L402 capability using proof.attenuate and audit the revocation snapshot.",
        ],
      },
    ],
  };
  const protectedHeader = {
    alg: "EdDSA",
    typ: "JOSE",
    kid,
    jku: canonicalUrl(A2A_DISCOVERY_PATHS[1]),
  };
  const protectedB64 = Buffer.from(jcs(protectedHeader), "utf8").toString(
    "base64url",
  );
  const payloadB64 = Buffer.from(jcs(unsignedCard), "utf8").toString(
    "base64url",
  );
  const signature = sign(
    null,
    Buffer.from(`${protectedB64}.${payloadB64}`, "ascii"),
    privateKey,
  ).toString("base64url");
  return {
    agentCard: {
      ...unsignedCard,
      signatures: [{ protected: protectedB64, signature }],
    },
    jwks,
  };
}
