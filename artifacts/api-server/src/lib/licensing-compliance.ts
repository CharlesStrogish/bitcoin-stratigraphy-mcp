import type { Request, Response } from "express";
import { AS_IS_TERMS } from "./as-is-terms";

/** Commercial positioning is transport metadata, never an MCP tool contract. */
export const licensingCompliance = Object.freeze({
  open_source_license: "AGPLv3 (Viral Network Copyleft under Section 13)",
  commercial_exemption:
    "Self-serve, time-locked AGPLv3 Section 13 Commercial Copyright Waivers; AS-IS, zero SLAs",
  terms: AS_IS_TERMS,
  waiver_quote_endpoint: "/api/v1/waivers/quote",
  waiver_claim_endpoint: "/api/v1/waivers/claim",
  waiver_usd_basis: { swarm_monthly: 2500, swarm_annual: 25000, global_monthly: 25000, global_annual: 250000 },
  procurement_url: "https://bitcoinstratigraphy.com/#enterprise-licensing",
});

export const LICENSING_COMPLIANCE_HEADER = "X-L402-Licensing-Compliance";

export function attachLicensingCompliance(res: Response): void {
  res.setHeader(
    LICENSING_COMPLIANCE_HEADER,
    JSON.stringify(licensingCompliance),
  );
}

export function logLicensingSettlement(req: Request): void {
  req.log?.info?.(
    { event: "l402_settlement", licensing_compliance: licensingCompliance },
    "L402 commercial compliance metadata",
  );
}
