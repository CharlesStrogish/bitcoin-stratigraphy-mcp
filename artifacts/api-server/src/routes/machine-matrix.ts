// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import express, { type Express } from "express";
import { fileURLToPath } from "node:url";

/** Only these public files bypass authentication; never expose the workspace. */
export function registerMachineMatrixRoutes(
  app: Express,
  directory = fileURLToPath(new URL("./public/.well-known/", import.meta.url)),
): void {
  const serve = express.static(directory, {
    index: false,
    redirect: false,
    dotfiles: "deny",
    fallthrough: false,
    maxAge: "5m",
    setHeaders(res) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.removeHeader("Access-Control-Allow-Credentials");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  });
  app.use("/.well-known", (req, res, next) => {
    if (!["/ai-plugin.json", "/mcp-configuration.json"].includes(req.path)) {
      next();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.removeHeader("Access-Control-Allow-Credentials");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.status(204).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD, OPTIONS");
      res.status(405).json({ error: "Read-only discovery manifest" });
      return;
    }
    serve(req, res, next);
  });
}
