// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON wire normalization, then recursive lexicographic object-key ordering. */
export function canonicalResultContent(
  result: Pick<CallToolResult, "content" | "structuredContent">,
): string {
  const payload: JsonValue = JSON.parse(
    JSON.stringify({
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
    }),
  );
  const encode = (value: JsonValue): string => {
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return encode(payload);
}

function keyId(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("Ed25519 key required");
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

export function signToolResponse(
  toolName: string,
  result: CallToolResult,
  privateKey: KeyObject,
  timestamp = Math.floor(Date.now() / 1000),
): CallToolResult {
  if (result.isError) return result;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error("Invalid signing timestamp");
  // Detach backend-owned objects so later mutation cannot invalidate the envelope.
  const detached = JSON.parse(JSON.stringify(result)) as CallToolResult;
  const contentSha256 = createHash("sha256")
    .update(canonicalResultContent(detached), "utf8")
    .digest("hex");
  const fingerprint = keyId(privateKey);
  const signature = sign(
    null,
    Buffer.from(`${toolName}.${timestamp}.${contentSha256}`, "utf8"),
    privateKey,
  ).toString("base64");
  return {
    ...detached,
    _meta: {
      ...detached._meta,
      responseSignature: {
        algorithm: "Ed25519",
        keyId: fingerprint,
        timestamp,
        contentSha256,
        signature: `v1a,${signature}`,
      },
    },
  };
}

/** The caller supplies an independently trusted key, never one from the envelope. */
export function verifyToolResponse(
  toolName: string,
  result: CallToolResult,
  trustedPublicKey: KeyObject,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  try {
    if (result.isError || !Array.isArray(result.content)) return false;
    const envelope = result._meta?.responseSignature as
      Record<string, unknown> | undefined;
    if (
      !envelope ||
      envelope.algorithm !== "Ed25519" ||
      envelope.keyId !== keyId(trustedPublicKey) ||
      !Number.isSafeInteger(envelope.timestamp) ||
      Number(envelope.timestamp) < 0 ||
      !Number.isFinite(nowSeconds) ||
      !Number.isFinite(toleranceSeconds) ||
      toleranceSeconds < 0 ||
      Math.abs(nowSeconds - Number(envelope.timestamp)) > toleranceSeconds ||
      typeof envelope.signature !== "string" ||
      !/^v1a,[A-Za-z0-9+/]{86}==$/.test(envelope.signature)
    )
      return false;
    const digest = createHash("sha256")
      .update(canonicalResultContent(result), "utf8")
      .digest("hex");
    if (digest !== envelope.contentSha256) return false;
    return verify(
      null,
      Buffer.from(`${toolName}.${envelope.timestamp}.${digest}`, "utf8"),
      trustedPublicKey,
      Buffer.from(envelope.signature.slice(4), "base64"),
    );
  } catch {
    return false;
  }
}
