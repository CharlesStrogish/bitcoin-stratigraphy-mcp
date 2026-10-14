// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { GetEnterpriseDueDiligenceBriefResponse } from "@workspace/api-zod";
import {
  DUE_DILIGENCE_BRIEF_FILENAME,
  DUE_DILIGENCE_BRIEF_PATH,
  enterpriseDueDiligenceBrief,
} from "../lib/enterprise-due-diligence";

// Fail at startup, not per request, if the brief drifts from its published contract.
GetEnterpriseDueDiligenceBriefResponse.parse(enterpriseDueDiligenceBrief);

/** Public, unmetered CISO brief; it never creates invoices or reads payment state. */
export function registerEnterpriseRoutes(app: Express): void {
  app.get(DUE_DILIGENCE_BRIEF_PATH, (_req, res): void => {
    res.set({
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": `inline; filename="${DUE_DILIGENCE_BRIEF_FILENAME}"`,
    });
    res.status(200).json(enterpriseDueDiligenceBrief);
  });
}
