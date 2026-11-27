import { build } from "../artifacts/api-server/node_modules/esbuild/lib/main.js";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, cpSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root } from "./site-integrity.mjs";

/** Exercise the real public GET handlers, never invoices, claims, or wallet APIs. */
export async function registerNavigationApi(app) {
  const api = path.join(root, "artifacts/api-server");
  mkdirSync(path.join(root, "generated-artifacts"), { recursive: true });
  const directory = mkdtempSync(
    path.join(root, "generated-artifacts/site-navigation-"),
  );
  try {
    symlinkSync(
      path.join(api, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    const out = path.join(directory, "bundle/navigation.mjs");
    mkdirSync(path.dirname(out), { recursive: true });
    cpSync(
      path.join(api, "data/stratigraphy.json"),
      path.join(directory, "data/stratigraphy.json"),
      { recursive: true },
    );
    await build({
      stdin: {
        contents: `
        export { registerOpenApiRoute } from "./src/routes/openapi";
        export { registerMcpServerCardRoute } from "./src/routes/mcp-server-card";
        export { registerSep2127DiscoveryRoutes } from "./src/routes/sep2127-discovery";
        export { registerA2aDiscoveryRoutes } from "./src/routes/a2a-discovery";
        export { registerToolIntegrityRoute } from "./src/routes/tool-integrity";
        export { registerStratigraphyRoutes } from "./src/routes/stratigraphy";
        export { mcpToolDefinitions } from "./src/routes/mcp";
        export { registerMcpDirectoryRoutes } from "./src/routes/mcp-directory";
        export { registerEnterpriseRoutes } from "./src/routes/enterprise";
        export { registerComplianceRoutes } from "./src/routes/compliance";
        export { registerFinalityRoutes } from "./src/routes/mcp-finality";
        export { FinalityError } from "./src/lib/mcp-finality-tasks";
      `,
        resolveDir: api,
        loader: "ts",
      },
      outfile: out,
      bundle: true,
      platform: "node",
      format: "esm",
      loader: { ".yaml": "text" },
      external: [
        "zod",
        "express",
        "@getalby/sdk",
        "nostr-tools",
        "yaml",
        "snarkjs",
        "poseidon-lite",
        "pino",
        "pino-pretty",
      ],
      banner: {
        js: `import {createRequire} from "node:module"; const require=createRequire(${JSON.stringify(path.join(api, "package.json"))});`,
      },
      logLevel: "silent",
    });
    const routes = await import(pathToFileURL(out).href);
    // Mount only captured, explicitly allowlisted GETs, even if a registration
    // function also owns paid handlers. No backend process or external requests.
    const allowed = new Set([
      "/openapi.json",
      "/.well-known/mcp.json",
      "/.well-known/mcp/server-card.json",
      "/.well-known/ai-catalog.json",
      "/mcp/server-card",
      "/server-card",
      "/.well-known/agent-card.json",
      "/.well-known/jwks.json",
      "/.well-known/integrity.json",
      "/api/v1/cost",
      "/mcp",
      "/api/v1/enterprise/due-diligence-brief",
      "/api/v1/compliance/revocation-snapshot",
      "/api/v1/finality/tasks/:taskId",
    ]);
    const capture = {
      locals: {},
      get(paths, ...handlers) {
        for (const route of Array.isArray(paths) ? paths : [paths])
          if (allowed.has(route)) app.get(route, ...handlers);
      },
      head() {},
      post() {},
      use() {},
      delete() {},
      put() {},
      patch() {},
    };
    routes.registerOpenApiRoute(capture);
    routes.registerMcpServerCardRoute(capture);
    routes.registerSep2127DiscoveryRoutes(capture);
    const key = generateKeyPairSync("ed25519").privateKey;
    routes.registerA2aDiscoveryRoutes(capture, key);
    routes.registerToolIntegrityRoute(capture, routes.mcpToolDefinitions, key);
    routes.registerMcpDirectoryRoutes(capture);
    routes.registerEnterpriseRoutes(capture);
    routes.registerComplianceRoutes(
      capture,
      {
        snapshot: async () => ({
          as_of: new Date().toISOString(),
          revoked_keys: [],
        }),
      },
      () => key,
    );
    routes.registerFinalityRoutes(capture, {
      dependencies: { ownership: { ownerHash() { throw new routes.FinalityError(403, "Owner proof required"); } } },
    });
    routes.registerStratigraphyRoutes(capture, () => {
      throw new Error("Wallet use forbidden in navigation audit");
    });
    return () => rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
