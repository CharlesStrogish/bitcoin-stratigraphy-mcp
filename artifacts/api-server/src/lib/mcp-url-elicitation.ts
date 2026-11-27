import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Request } from "express";
import { verifyRequestNip98Signer } from "./nip98-request";
import { CANONICAL_ORIGIN } from "./public-site";
import {
  type CheckoutIntent,
  type HandoffRecord,
  type UrlElicitationStore,
  postgresUrlElicitationStore,
} from "./mcp-url-elicitation-store";

export const URL_HANDOFF_METHOD = "checkout/handoff";
export const URL_HANDOFF_STATUS = "/api/v1/mcp/elicitation";
export const URL_HANDOFF_PAGE = "/api/v1/mcp/checkout-handoff";
export const URL_HANDOFF_TTL_MS = 15 * 60_000;
export const MCP_OWNER_HEADER = "X-MCP-Owner-Key";
export const MCP_HANDOFF_HEADER = "X-MCP-Elicitation-Id";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class UrlHandoffError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function clientSupportsUrlElicitation(capabilities: unknown): boolean {
  return Boolean(
    (capabilities as { elicitation?: { url?: unknown } } | undefined)
      ?.elicitation?.url,
  );
}
export function checkoutIntent(value: unknown): value is CheckoutIntent {
  return value === "scanner_pack_checkout" || value === "agpl_waiver_checkout";
}

export class McpUrlElicitation {
  constructor(
    readonly store: UrlElicitationStore = postgresUrlElicitationStore(),
    private readonly secret: () => string | undefined = () =>
      process.env.SESSION_SECRET,
    readonly now: () => number = Date.now,
  ) {}

  ownerHash(req: Request): string {
    const signer = verifyRequestNip98Signer(req, this.now());
    let owner: string;
    if (signer.provided) {
      if (!signer.pubkey)
        throw new UrlHandoffError(
          403,
          "Fresh request-bound NIP-98 ownership required",
        );
      owner = "nip98:" + signer.pubkey;
    } else {
      // A dedicated, client-generated 256-bit pairing proof, not a session ID,
      // payment credential, IP address or self-declared public client name.
      const key = req.get(MCP_OWNER_HEADER);
      if (!key || !/^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/.test(key))
        throw new UrlHandoffError(
          403,
          "Provide NIP-98 or a separate 256-bit X-MCP-Owner-Key",
        );
      owner = "client:" + key;
    }
    const secret = this.secret();
    if (!secret)
      throw new UrlHandoffError(503, "Checkout handoff ownership unavailable");
    return createHmac("sha256", secret)
      .update("mcp-url-owner-v1\0" + owner)
      .digest("hex");
  }

  async rememberClient(
    owner: string,
    capabilities: unknown,
    protocolVersion: string,
  ) {
    await this.store.remember(owner, {
      url: clientSupportsUrlElicitation(capabilities),
      protocolVersion,
      expiresAt: this.now() + URL_HANDOFF_TTL_MS,
    });
  }
  async supportsRememberedClient(owner: string, protocolVersion: string) {
    const client = await this.store.capabilities(owner);
    return Boolean(
      client?.url &&
      client.expiresAt > this.now() &&
      client.protocolVersion === protocolVersion,
    );
  }
  async create(intent: CheckoutIntent, ownerHash: string) {
    if (!checkoutIntent(intent) || !/^[0-9a-f]{64}$/.test(ownerHash))
      throw new UrlHandoffError(400, "Invalid checkout handoff");
    const createdAt = this.now();
    const record: HandoffRecord = {
      elicitationId: randomUUID(),
      intent,
      ownerHash,
      status: "pending",
      createdAt,
      expiresAt: createdAt + URL_HANDOFF_TTL_MS,
      revision: 0,
    };
    await this.store.create(record);
    return record;
  }
  async getHandoffStatus(id: string, owner: string): Promise<HandoffRecord> {
    if (!UUID.test(id))
      throw new UrlHandoffError(404, "Checkout handoff not found");
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await this.store.get(id);
      if (!row || row.ownerHash !== owner)
        throw new UrlHandoffError(404, "Checkout handoff not found");
      if (this.now() >= row.expiresAt || row.status === "expired") {
        if (
          row.status !== "expired" &&
          !(await this.store.replace(
            { ...row, status: "expired", revision: row.revision + 1 },
            row.revision,
          ))
        )
          continue;
        throw new UrlHandoffError(
          410,
          "Checkout handoff expired; recover any existing purchase before starting another",
        );
      }
      if (row.status === "cancelled")
        throw new UrlHandoffError(409, "Checkout handoff cancelled");
      return row;
    }
    throw new UrlHandoffError(409, "Checkout handoff changed; poll again");
  }
  async bindReference(id: string, owner: string, referenceId: string) {
    if (!/^(?:scanner:[0-9a-f]{64}|waiver:[0-9a-f-]{36})$/.test(referenceId))
      throw new UrlHandoffError(400, "Invalid checkout reference");
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await this.getHandoffStatus(id, owner);
      if (
        referenceId.startsWith("scanner:") !==
        (row.intent === "scanner_pack_checkout")
      )
        throw new UrlHandoffError(403, "Checkout reference intent mismatch");
      if (row.referenceId && row.referenceId !== referenceId)
        throw new UrlHandoffError(
          409,
          "Recover the checkout already linked to this handoff",
        );
      if (row.referenceId === referenceId) return row;
      if (row.status !== "pending")
        throw new UrlHandoffError(409, "Checkout handoff is closed");
      const updated = { ...row, referenceId, revision: row.revision + 1 };
      if (await this.store.replace(updated, row.revision)) return updated;
    }
    throw new UrlHandoffError(409, "Checkout handoff changed; poll again");
  }
  /** Reserve before invoking an existing checkout, including across replicas.
   * Unknown outcomes stay reserved: never silently create a second purchase/address. */
  async reserveCheckout(id: string, owner: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await this.getHandoffStatus(id, owner);
      if (row.status !== "pending" || row.referenceId || row.checkoutStarted)
        throw new UrlHandoffError(
          409,
          "Recover the checkout already started; do not pay again",
        );
      if (
        await this.store.replace(
          { ...row, checkoutStarted: true, revision: row.revision + 1 },
          row.revision,
        )
      )
        return;
    }
    throw new UrlHandoffError(409, "Checkout already started; use recovery");
  }
  /** Only a definitive pre-payment input/origin rejection may release admission. */
  async releaseRejectedCheckout(id: string, owner: string) {
    const row = await this.getHandoffStatus(id, owner);
    if (!row.referenceId && row.status === "pending")
      await this.store.replace(
        { ...row, checkoutStarted: false, revision: row.revision + 1 },
        row.revision,
      );
  }
  /** Internal only: callers must first confirm the existing server-side payment/claim. */
  async markHandoffCompleted(id: string, owner: string, referenceId: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await this.getHandoffStatus(id, owner);
      if (!row.referenceId || row.referenceId !== referenceId)
        throw new UrlHandoffError(
          403,
          "Verified checkout reference does not match",
        );
      if (row.status === "completed") return row;
      const updated: HandoffRecord = {
        ...row,
        status: "completed",
        completedAt: this.now(),
        revision: row.revision + 1,
      };
      if (await this.store.replace(updated, row.revision)) return updated;
    }
    throw new UrlHandoffError(409, "Checkout completion changed; poll again");
  }
  publicStatus(row: HandoffRecord) {
    return {
      elicitationId: row.elicitationId,
      intent: row.intent,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ...(row.completedAt === undefined
        ? {}
        : { completedAt: row.completedAt }),
    };
  }
  elicitation(row: HandoffRecord) {
    const url = new URL(URL_HANDOFF_PAGE, CANONICAL_ORIGIN);
    url.searchParams.set("handoff", row.elicitationId);
    url.searchParams.set(
      "intent",
      row.intent === "agpl_waiver_checkout" ? "agpl_waiver" : "scanner_pack",
    );
    return {
      mode: "url" as const,
      elicitationId: row.elicitationId,
      url: url.href,
      message: `Open the verified Bitcoin Stratigraphy checkout page to ${row.intent === "agpl_waiver_checkout" ? "review the AGPLv3 waiver terms" : "review the Scanner Pack"}. Prove the same ownership using a fresh NIP-98 signature or your separate client-generated pairing key. Only an explicit human action starts checkout; do not send wallet or payment credentials. Keep any existing purchase for recovery.`,
    };
  }
}

/** A non-reversible local correlation reference, never the browser's owner cookie. */
export function scannerHandoffReference(cookie: string) {
  return (
    "scanner:" +
    createHash("sha256")
      .update("mcp-scanner-reference-v1\0" + cookie)
      .digest("hex")
  );
}
