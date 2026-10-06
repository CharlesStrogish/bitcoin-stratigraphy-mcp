// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import type { Express } from "express";
import { openApiDocument } from "../openapi";

const serializedOpenApiDocument = JSON.stringify(openApiDocument);

export function registerOpenApiRoute(app: Express): void {
  app.get("/openapi.json", (_req, res): void => {
    res.status(200).type("application/json").send(serializedOpenApiDocument);
  });
}
