import type { Request } from "express";
import {
  verifyNip98Signer,
  type AgentIdentity,
  type AgentReputationService,
} from "../services/agentReputation";

/**
 * NIP-98 HTTP Auth binding shared by every route that accepts a Nostr agent
 * identity. The signed `u` tag must equal NIP98_PUBLIC_ORIGIN (or the proxied
 * request origin) joined with req.originalUrl, the URL the client requested.
 */
export function requestNip98Url(req: Request): string {
  const configuredOrigin = process.env.NIP98_PUBLIC_ORIGIN;
  const origin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : `${req.protocol}://${req.get("host")}`;
  return new URL(req.originalUrl, `${origin}/`).toString();
}

/**
 * The NIP-98 event header. X-Nostr-Authorization wins because Authorization
 * may already carry an L402 credential; otherwise `Authorization: Nostr ...`.
 */
export function requestNip98Authorization(req: Request): string | undefined {
  const supplemental = req.header("X-Nostr-Authorization");
  const primary = req.header("Authorization");
  return supplemental ?? (primary?.startsWith("Nostr ") ? primary : undefined);
}

/**
 * Exact body bytes the `payload` tag must hash: the captured raw request body,
 * or its JSON serialization when no raw capture exists. Bodiless requests
 * sign no payload tag.
 */
export function requestNip98Payload(req: Request): Uint8Array | undefined {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw) return raw.length > 0 ? raw : undefined;
  if (Buffer.isBuffer(req.body)) return req.body.length ? req.body : undefined;
  const serialized =
    req.body === undefined ? undefined : JSON.stringify(req.body);
  return serialized === undefined ? undefined : Buffer.from(serialized);
}

export function verifyRequestAgent(
  req: Request,
  reputation: AgentReputationService,
  nowMs: number,
  payload?: Uint8Array,
): { provided: boolean; identity?: AgentIdentity } {
  const authorization = requestNip98Authorization(req);
  if (!authorization) return { provided: false };
  const identity = reputation.verifyNip98Authorization({
    authorization,
    method: req.method,
    url: requestNip98Url(req),
    nowSeconds: Math.floor(nowMs / 1_000),
    payload,
  });
  return identity ? { provided: true, identity } : { provided: true };
}

/**
 * Verifies the request's optional NIP-98 event against its method, URL and
 * exact body. `pubkey: null` means an event was sent but is invalid or forged.
 */
export function verifyRequestNip98Signer(
  req: Request,
  nowMs: number,
): { provided: false } | { provided: true; pubkey: string | null } {
  const authorization = requestNip98Authorization(req);
  if (!authorization) return { provided: false };
  return {
    provided: true,
    pubkey: verifyNip98Signer({
      authorization,
      method: req.method,
      url: requestNip98Url(req),
      nowSeconds: Math.floor(nowMs / 1_000),
      payload: requestNip98Payload(req),
    }),
  };
}
