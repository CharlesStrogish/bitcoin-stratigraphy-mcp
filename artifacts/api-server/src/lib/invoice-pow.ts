// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";
import {
  postgresInvoicePowStore,
  type InvoicePowStore,
} from "./postgres-invoice-pow-store";

export const INVOICE_POW_DIFFICULTY = 3;
export const INVOICE_POW_TTL_MS = 120_000;
export const POW_CHALLENGE_HEADER = "X-L402-PoW-Challenge";
export const POW_NONCE_HEADER = "X-L402-PoW-Nonce";

/** Stateless issuance authenticated with the existing shared session secret.
 * Only valid solved proofs reserve PostgreSQL rows, atomically across workers.
 * No raw nonce, request data or signing secret is stored in the database.
 */
export function createInvoicePow(
  options: {
    now?: () => number;
    difficulty?: number;
    store?: InvoicePowStore;
  } = {},
) {
  const now = options.now ?? Date.now;
  const difficulty = options.difficulty ?? INVOICE_POW_DIFFICULTY;
  if (!Number.isInteger(difficulty) || difficulty < 2 || difficulty > 4)
    throw new RangeError(
      "Invoice PoW difficulty must be 2–4 leading hex zeros",
    );
  const store = options.store ?? postgresInvoicePowStore;

  return {
    async admit(
      req: Request,
      res: Response,
      binding: string,
      secret: string,
    ): Promise<boolean> {
      if (!secret) {
        res.set("Cache-Control", "no-store");
        res
          .status(503)
          .json({ error: "Invoice proof authentication is not configured" });
        return false;
      }
      const mac = (value: string) =>
        createHmac("sha256", secret)
          .update("bitcoin-stratigraphy/invoice-pow/v1\n")
          .update(value)
          .digest();
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
                createHash("sha256")
                  .update(`${challenge}:${nonce}`)
                  .digest("hex")
                  .startsWith("0".repeat(difficulty))
              ) {
                try {
                  if (
                    await store.consume(
                      createHash("sha256").update(challenge).digest("hex"),
                      payload.expires,
                    )
                  )
                    return true;
                } catch (error) {
                  req.log?.warn(
                    { err: error },
                    "Invoice proof reservation unavailable",
                  );
                  res.set("Cache-Control", "no-store");
                  res.set("Retry-After", "5");
                  res
                    .status(503)
                    .json({
                      error:
                        "Invoice proof admission storage is unavailable; retry later",
                    });
                  return false;
                }
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

// Every MCP single-tool and pipeline gate uses the shared PostgreSQL store.
export const invoicePow = createInvoicePow();
