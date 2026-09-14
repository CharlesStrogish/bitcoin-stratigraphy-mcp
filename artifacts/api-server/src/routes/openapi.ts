import type { Express } from "express";
import { openApiDocument } from "../openapi";

const serializedOpenApiDocument = JSON.stringify(openApiDocument);

export function registerOpenApiRoute(app: Express): void {
  app.get("/openapi.json", (_req, res): void => {
    res
      .status(200)
      .type("application/json")
      .send(serializedOpenApiDocument);
  });
}