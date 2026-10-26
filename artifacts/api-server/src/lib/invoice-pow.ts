// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";

export const INVOICE_POW_DIFFICULTY = 3;
export const INVOICE_POW_TTL_MS = 120_000;
export const POW_CHALLENGE_HEADER = "X-L402-PoW-Challenge";
export const POW_NONCE_HEADER = "X-L402-PoW-Nonce";

/** Stateless issuance, bounded single-use admission, and no wallet/DB calls.
 * The ephemeral process key prevents replay across workers; a worker change or
 * restart simply requires a fresh challenge. No unverified caller state is kept.
 */
export function createInvoicePow(
  options: {
    now?: () => number;
    difficulty?: number;
    maxConsumed?: number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const difficulty = options.difficulty ?? INVOICE_POW_DIFFICULTY;
  const maxConsumed = options.maxConsumed ?? 20_000;
  if (!Number.isInteger(difficulty) || difficulty < 2 || difficulty > 4)
    throw new RangeError(
      "Invoice PoW difficulty must be 2–4 leading hex zeros",
    );
  if (!Number.isSafeInteger(maxConsumed) || maxConsumed < 1)
    throw new RangeError("Invoice PoW replay capacity must be positive");
  const key = randomBytes(32);
  const consumed = new Map<string, number>();
  let lastCleanup = 0;
  const mac = (value: string) =>
    createHmac("sha256", key).update(value).digest();

  return {
    admit(req: Request, res: Response, binding: string): boolean {
      const current = now();
      const challenge = req.get(POW_CHALLENGE_HEADER);
      const nonce = req.get(POW_NONCE_HEADER);
      if (
        challenge &&
        challenge.length <= 1024 &&
        nonce &&
        /^[0-9]{1,20}$/.test(nonce)
      ) {
        const parts = challenge.split(".");
        if (parts.length === 2 && /^[0-9a-f]{64}$/.test(parts[1]!)) {
          const expected = mac(parts[0]!);
          if (timingSafeEqual(expected, Buffer.from(parts[1]!, "hex"))) {
            try {
              const payload = JSON.parse(
                Buffer.from(parts[0]!, "base64url").toString(),
              );
              if (
                payload.v === 1 &&
                payload.binding === binding &&
                payload.difficulty === difficulty &&
                Number.isSafeInteger(payload.expires) &&
                payload.expires > current &&
                payload.expires <= current + INVOICE_POW_TTL_MS &&
                !consumed.has(parts[1]!) &&
                createHash("sha256")
                  .update(`${challenge}:${nonce}`)
                  .digest("hex")
                  .startsWith("0".repeat(difficulty))
              ) {
                if (
                  current - lastCleanup >= 10_000 ||
                  consumed.size >= maxConsumed
                ) {
                  for (const [id, expires] of consumed)
                    if (expires <= current) consumed.delete(id);
                  lastCleanup = current;
                }
                if (consumed.size >= maxConsumed) {
                  res.set("Retry-After", "120");
                  res.set("Cache-Control", "no-store");
                  res
                    .status(503)
                    .json({
                      error:
                        "Invoice proof admission is at capacity; retry later",
                    });
                  return false;
                }
                // Synchronous reservation precedes the first wallet await.
                consumed.set(parts[1]!, payload.expires);
                return true;
              }
            } catch {
              /* Malformed authenticated payloads fail closed. */
            }
          }
        }
      }
      const expires = current + INVOICE_POW_TTL_MS;
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          id: randomBytes(24).toString("hex"),
          binding,
          difficulty,
          expires,
        }),
      ).toString("base64url");
      res.set("Cache-Control", "no-store");
      res.status(400).json({
        error:
          "Missing, invalid, expired or already-used invoice proof of work",
        code: "invoice_pow_required",
        proof_of_work: {
          algorithm: "sha256",
          challenge: `${payload}.${mac(payload).toString("hex")}`,
          difficulty,
          expires_at: new Date(expires).toISOString(),
          hash_input: "challenge:nonce",
          nonce_format: "1–20 decimal digits",
          challenge_header: POW_CHALLENGE_HEADER,
          nonce_header: POW_NONCE_HEADER,
        },
      });
      return false;
    },
  };
}

// Shared by every MCP single-tool and pipeline gate in this process.
export const invoicePow = createInvoicePow();
