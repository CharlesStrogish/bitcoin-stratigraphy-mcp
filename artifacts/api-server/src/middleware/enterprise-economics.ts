// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import type { RequestHandler } from "express";
import {
  enterpriseContext,
  type EnterpriseContext,
  type EnterpriseEconomics,
} from "../lib/enterprise-economics";
import { verifyRequestNip98Signer } from "../lib/nip98-request";
import type { SwarmProtocol } from "../lib/swarm-protocol";

/** Validate an opaque LNURL without resolving it or making a payout/network call. */
export function parseAgentPayout(
  address?: string,
  lnurl?: string,
): string | undefined {
  if (address !== undefined && lnurl !== undefined)
    throw new Error("Use only one agent payout header");
  if (address !== undefined) {
    if (
      address.length > 254 ||
      !/^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
        address,
      )
    ) {
      throw new Error("Invalid X-Agent-Lightning-Address");
    }
    const [local, domain] = address.split("@");
    return local + "@" + domain!.toLowerCase();
  }
  if (lnurl === undefined) return undefined;
  // Both public routing identifiers are accepted; addresses remain opaque and
  // are never resolved or contacted by the accounting layer.
  if (lnurl.includes("@")) return parseAgentPayout(lnurl);
  if (
    lnurl.length > 2_048 ||
    (lnurl !== lnurl.toLowerCase() && lnurl !== lnurl.toUpperCase())
  ) {
    throw new Error("Invalid X-Agent-LNURL");
  }
  const value = lnurl.toLowerCase();
  if (!/^lnurl1[023456789acdefghjklmnpqrstuvwxyz]{6,}$/.test(value))
    throw new Error("Invalid X-Agent-LNURL");
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const hrp = "lnurl";
  const words = [...hrp]
    .map((c) => c.charCodeAt(0) >> 5)
    .concat(
      0,
      [...hrp].map((c) => c.charCodeAt(0) & 31),
      [...value.slice(6)].map((c) => alphabet.indexOf(c)),
    );
  let check = 1;
  const generators = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  for (const word of words) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ word;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= generators[i]!;
  }
  if (check >>> 0 !== 1) throw new Error("Invalid X-Agent-LNURL checksum");
  return value;
}

export function createEnterpriseEconomicsMiddleware(
  service: EnterpriseEconomics,
  protocol?: SwarmProtocol,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const payout = parseAgentPayout(
        req.get("X-Agent-Lightning-Address"),
        req.get("X-Agent-LNURL"),
      );
      const parentPayout = parseAgentPayout(
        undefined,
        req.get("X-Parent-Agent-LNURL"),
      );
      if (parentPayout && (!payout || parentPayout === payout)) {
        res.status(400).json({
          error: "X-Parent-Agent-LNURL requires a distinct direct agent payout",
        });
        return;
      }
      const declared = req.get("Buyer-Pubkey");
      const signer = verifyRequestNip98Signer(req, service.now());
      if (signer.provided && !signer.pubkey) {
        res.status(401).json({ error: "Invalid NIP-98 buyer authentication" });
        return;
      }
      const buyer = signer.provided ? signer.pubkey! : undefined;
      if (
        declared !== undefined &&
        (!/^[0-9a-fA-F]{64}$/.test(declared) ||
          declared.toLowerCase() !== buyer)
      ) {
        res
          .status(401)
          .json({ error: "Buyer-Pubkey must match a fresh NIP-98 signer" });
        return;
      }
      const context: EnterpriseContext = {
        buyer,
        payout,
        parentPayout,
        account: buyer ? await service.status(buyer) : undefined,
        invoices: new Map(),
        now: service.now,
        onSettlement: () => update(),
      };
      if (protocol) await protocol.prepare(req, context);
      res.locals.swarmContext = context;
      const update = () => {
        if (!buyer && !payout) return;
        const status = service.describe(context);
        if (!res.headersSent) {
          res.setHeader(
            "X-Commercial-Exemption-Status",
            String(status.commercial_exemption_status),
          );
          const token = status.commercial_exemption_token;
          if (token) {
            res.setHeader(
              "X-Commercial-Exemption-Token",
              Buffer.from(JSON.stringify(token)).toString("base64url"),
            );
            res.setHeader(
              "X-Commercial-Exemption-Expires",
              String((token as Record<string, unknown>).expiry_date),
            );
          } else {
            res.removeHeader("X-Commercial-Exemption-Token");
            res.removeHeader("X-Commercial-Exemption-Expires");
          }
        }
        req.log?.info?.(
          {
            event: "enterprise_licensing_status",
            buyer_pubkey: buyer ?? null,
            commercial_exemption_status: status.commercial_exemption_status,
            licensing_status:
              status.commercial_exemption_status === "Active"
                ? "Tier II Commercial Enterprise Exemption"
                : "AGPLv3 viral copyleft — no active commercial exemption",
            copyleft_risk:
              status.commercial_exemption_status === "Active"
                ? "commercially_exempt"
                : "high",
            legal_scope:
              "Actual AGPL obligations depend on covered software and use",
          },
          "Enterprise licensing status",
        );
      };
      update();
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        if (
          (buyer || payout) &&
          body &&
          typeof body === "object" &&
          (req.path === "/api/v1/cost" ||
            (req.path.startsWith("/api/v1/") && res.statusCode === 402)) &&
          !Array.isArray(body)
        ) {
          body = {
            ...body,
            enterprise_economics: service.describe(context),
            ...(context.invoices.size
              ? {
                  autonomous_routing_kickbacks: [...context.invoices.values()]
                    .filter((i) => i.payout)
                    .map((i) => i.allocation),
                }
              : {}),
          };
        }
        return json(body);
      };
      enterpriseContext.run(context, next);
    } catch (error) {
      if (
        error instanceof RangeError || (error instanceof Error &&
        /payout header|X-Agent-/.test(error.message))
      ) {
        res.status(400).json({ error: error.message });
        return;
      }
      req.log?.error?.({ err: error }, "Enterprise economics unavailable");
      res.status(503).json({
        error: "Enterprise accounting unavailable; no entitlement was granted",
      });
    }
  };
}
