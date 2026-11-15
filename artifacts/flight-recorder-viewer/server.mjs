// Copyright (c) 2026 Charles R. Strogish. AGPL-3.0-only.
import { createServer } from "node:http";
import { existsSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConnectionService, connectionMiddleware } from "./server/connection.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(directory, ".env"))) process.loadEnvFile(path.join(directory, ".env"));
const base = (process.env.BASE_PATH || "/").replace(/\/?$/, "/");
const root = path.join(directory, "dist/public");
const connection = connectionMiddleware(createConnectionService(), base);
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".json": "application/json" };
export const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    await connection(req, res, async () => {
      if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (!pathname.startsWith(base)) { res.writeHead(404).end(); return; }
      const relative = pathname.slice(base.length);
      if (relative.split("/").some(part => part.startsWith("."))) { res.writeHead(404).end(); return; }
      let file = path.resolve(root, relative || "index.html");
      if (!file.startsWith(`${root}/`)) { res.writeHead(404).end(); return; }
      try {
        if (!(await stat(file)).isFile()) throw new Error("Not a file");
      } catch {
        if (path.extname(relative) || relative.startsWith("local-api/")) { res.writeHead(404).end(); return; }
        file = path.join(root, "index.html");
      }
      res.setHeader("Content-Type", `${mime[path.extname(file)] || "application/octet-stream"}; charset=utf-8`);
      res.setHeader("Cache-Control", file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
      if (req.method === "HEAD") { res.end(); return; }
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    });
  } catch {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"Viewer request failed"}');
  }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(Number(process.env.PORT || 4173), process.env.HOST || "127.0.0.1");
}
