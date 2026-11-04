// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { resolve } from "node:path";
import type { RequestHandler } from "express";
import { loadToolIntegrityKey } from "./tool-integrity";

/** Separate signing identity: never rotate the existing manifest/webhook key. */
export function loadPayloadSigningKey(env = process.env): KeyObject {
  if (env.STRATIGRAPHY_PAYLOAD_PRIVATE_KEY !== undefined) {
    const key = createPrivateKey(env.STRATIGRAPHY_PAYLOAD_PRIVATE_KEY);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("Ed25519 payload key required");
    return key;
  }
  if (env.SESSION_SECRET !== undefined) {
    if (!env.SESSION_SECRET) throw new Error("Empty payload signing seed");
    const seed = Buffer.from(
      hkdfSync(
        "sha256",
        env.SESSION_SECRET,
        "bitcoinstratigraphy/payload/v1",
        "ed25519-signing-seed",
        32,
      ),
    );
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
    try {
      return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } finally {
      seed.fill(0);
      der.fill(0);
    }
  }
  if (env.NODE_ENV === "production")
    throw new Error("Persistent payload signing secret required");
  return loadToolIntegrityKey(
    {},
    resolve(env.STRATIGRAPHY_PAYLOAD_KEYS_DIR ?? ".keys/payload"),
  );
}

export function payloadPublicIdentity(key: KeyObject) {
  const publicKey = createPublicKey(key);
  return {
    algorithm: "Ed25519",
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
}

/**
 * Sign final serialized HTTP bytes, including JSON-RPC framing and metadata.
 * Finite MCP responses are buffered so headers precede even transport.writeHead.
 * No JSON reserialization or cross-language canonicalization is used by clients.
 */
export function payloadAttestation(readKey: () => KeyObject): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "POST") {
      next();
      return;
    }
    let key: KeyObject;
    try {
      key = readKey();
    } catch {
      res.status(503).json({ error: "Payload signing unavailable" });
      return;
    }
    // The JSON parser preserves raw request bytes in rawBody in the core app.
    const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const requestDigest = createHash("sha256")
      .update(raw ?? JSON.stringify(req.body) ?? "")
      .digest("hex");
    const prefix = Buffer.from(
      `bitcoinstratigraphy/payload/v1\n${requestDigest}\n`,
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    const end = res.end;
    const writeHead = res.writeHead;
    res.flushHeaders = () => {};
    res.writeHead = ((status: number, ...args: unknown[]) => {
      res.statusCode = status;
      const headers = typeof args[0] === "string" ? args[1] : args[0];
      if (headers && typeof headers === "object") {
        if (Array.isArray(headers)) {
          for (let i = 0; i < headers.length; i += 2)
            res.setHeader(headers[i], headers[i + 1]);
        } else {
          for (const [name, value] of Object.entries(headers))
            res.setHeader(name, value as string);
        }
      }
      return res;
    }) as typeof res.writeHead;
    const append = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null) return;
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(
              chunk,
              typeof encoding === "string"
                ? (encoding as BufferEncoding)
                : "utf8",
            )
          : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 8 * 1024 * 1024) {
        oversized = true;
        chunks.length = 0;
      }
      if (!oversized) chunks.push(bytes);
    };
    res.write = ((
      chunk: unknown,
      encoding?: unknown,
      callback?: () => void,
    ) => {
      append(chunk, encoding);
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") queueMicrotask(() => done());
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown, callback?: () => void) => {
      append(typeof chunk === "function" ? undefined : chunk, encoding);
      const body = oversized
        ? Buffer.from('{"error":"MCP attestation response too large"}')
        : Buffer.concat(chunks);
      if (oversized) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Length", body.length);
      }
      res.setHeader(
        "X-Stratigraphy-Signature",
        `v1,${sign(null, Buffer.concat([prefix, body]), key).toString("base64")}`,
      );
      res.setHeader("X-Stratigraphy-Key-Id", payloadPublicIdentity(key).keyId);
      res.append(
        "Access-Control-Expose-Headers",
        "X-Stratigraphy-Signature, X-Stratigraphy-Key-Id",
      );
      res.setHeader("Cache-Control", "no-store");
      res.writeHead = writeHead;
      const done =
        typeof chunk === "function"
          ? chunk
          : typeof encoding === "function"
            ? encoding
            : callback;
      return end.call(res, body, "utf8", done as (() => void) | undefined);
    }) as typeof res.end;
    next();
  };
}
