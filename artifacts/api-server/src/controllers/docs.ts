import type { RequestHandler } from "express";
import path from "node:path";

export const cookbookFiles = new Set([
  "README.md",
  "requirements.txt",
  "l402_client.py",
  "langchain_example.py",
  "autogen_example.py",
  "crewai_example.py",
]);

export const frameworkCookbookFiles = new Set([
  "langchain_agent.py",
  "llamaindex_agent.py",
  "README.md",
  "requirements-langchain.txt",
  "requirements-llamaindex.txt",
]);

export function docsController(directory: string): RequestHandler {
  return (_req, res, next) => {
    res.set({
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'",
    });
    res.sendFile(path.join(directory, "index.html"), (error) => {
      if (error) next(error);
    });
  };
}

export function cookbookController(directory: string, allowedFiles = cookbookFiles): RequestHandler {
  return (req, res, next) => {
    const filename = String(req.params.filename);
    if (!allowedFiles.has(filename)) {
      res.status(404).type("text/plain").send("Cookbook not found");
      return;
    }
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
      "Content-Type": "text/plain; charset=utf-8",
    });
    if (req.query.download === "1") {
      res.attachment(filename);
      res.type("text/plain; charset=utf-8");
    }
    res.sendFile(path.join(directory, filename), (error) => {
      if (error) next(error);
    });
  };
}