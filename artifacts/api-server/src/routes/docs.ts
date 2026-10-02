import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cookbookController, docsController } from "../controllers/docs";

// The server build copies both folders alongside the bundled entry point.
export function registerDocsRoutes(
  app: Express,
  publicRoot = fileURLToPath(new URL("./public/", import.meta.url)),
): void {
  const docsRoot = path.join(publicRoot, "docs");
  app.get(/^\/docs\/?$/, docsController(docsRoot));
  app.use("/docs/assets", express.static(docsRoot, {
    index: false,
    dotfiles: "deny",
    setHeaders(res) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-cache");
    },
  }));
  app.get("/cookbooks/:filename", cookbookController(path.join(publicRoot, "cookbooks")));
}