import type { Request, Response } from "express";

/** Commercial positioning is transport metadata, never an MCP tool contract. */
export const licensingCompliance = Object.freeze({
  open_source_license: "AGPLv3 (Viral Network Copyleft under Section 13)",
  commercial_exemption:
    "Required for closed-source model weights, private VPC swarms, and proprietary enterprise logic ($250,000/yr Tier II Commercial Enterprise Exemption)",
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
  req.log?.info(
    { event: "l402_settlement", licensing_compliance: licensingCompliance },
    "L402 commercial compliance metadata",
  );
}
