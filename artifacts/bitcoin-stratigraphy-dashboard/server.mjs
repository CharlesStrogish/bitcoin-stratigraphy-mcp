import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import TOML from "@iarna/toml";
import { redirectLegacyDomain } from "./domain-redirect.mjs";

const artifactDirectory = path.dirname(fileURLToPath(import.meta.url));

export function createFrontendApp({
  publicDirectory = path.join(artifactDirectory, "dist/public"),
} = {}) {
  const manifest = TOML.parse(readFileSync(
    path.join(artifactDirectory, ".replit-artifact/artifact.toml"), "utf8",
  ));
  const production = manifest.services.find(({ name }) => name === "web").production;
  const app = express();
  app.disable("x-powered-by");
  app.use(redirectLegacyDomain);
  app.use((req, res, next) => {
    for (const header of production.responseHeaders ?? []) {
      if (header.path === "/*" || header.path === req.path)
        res.setHeader(header.name, header.value);
    }
    next();
  });
  // These routes belong to separate artifact services, never to the SPA.
  app.use((req, res, next) => {
    if (/^\/(?:api|mcp|invoice|agent-api)(?:\/|$)/.test(req.path)) {
      res.sendStatus(404);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.sendStatus(405);
      return;
    }
    next();
  });
  // Keep dedicated-page metadata ahead of both static directory handling and the SPA.
  app.use((req, res, next) => {
    const rewrite = (production.rewrites ?? []).find(({ from }) => from === req.path);
    if (!rewrite) return next();
    res.sendFile(rewrite.to.replace(/^\/+/, ""), { root: publicDirectory });
  });
  app.use(express.static(publicDirectory, { redirect: false, dotfiles: "deny" }));
  app.use((req, res) => {
    if (req.path.split("/").some((segment) => segment.startsWith(".")) ||
        path.posix.extname(req.path)) {
      res.sendStatus(404);
      return;
    }
    const fallback = (production.rewrites ?? []).find(({ from }) => from === "/*");
    if (!fallback) {
      res.sendStatus(404);
      return;
    }
    res.sendFile(fallback.to.replace(/^\/+/, ""), { root: publicDirectory });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.env.BASE_PATH)
    throw new Error("BASE_PATH environment variable is required but was not provided.");
  if (process.env.BASE_PATH !== "/")
    throw new Error("This frontend is registered at BASE_PATH=/.");
  if (!process.env.PORT)
    throw new Error("PORT environment variable is required but was not provided.");
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const publicDirectory = path.join(artifactDirectory, "dist/public");
  // Fail startup explicitly if the frontend was not built.
  readFileSync(path.join(publicDirectory, "index.html"));
  createFrontendApp({ publicDirectory }).listen(port, "0.0.0.0", () => {
    console.log(`Frontend listening on port ${port}`);
  });
}
