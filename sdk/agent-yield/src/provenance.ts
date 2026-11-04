// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import { createHash, createPublicKey, verify } from "node:crypto";

export class FiduciaryTamperingError extends Error {
  constructor() {
    super("Data payload signature verification failed.");
    this.name = "FiduciaryTamperingError";
  }
}

/** The key must come from operator configuration, not the response being checked. */
export function verifyPayload(
  bytes: Uint8Array,
  signature: string | null,
  request: string,
  publicKey?: string,
): void {
  try {
    if (!publicKey || !signature || !/^v1,[A-Za-z0-9+/]{86}==$/.test(signature))
      throw new Error();
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    const digest = createHash("sha256").update(request).digest("hex");
    const message = Buffer.concat([
      Buffer.from(`bitcoinstratigraphy/payload/v1\n${digest}\n`),
      Buffer.from(bytes),
    ]);
    if (!verify(null, message, key, Buffer.from(signature.slice(3), "base64")))
      throw new Error();
  } catch {
    throw new FiduciaryTamperingError();
  }
}
