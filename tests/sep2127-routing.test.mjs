import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "@iarna/toml";

test("API artifact explicitly owns SEP-2127 discovery before MCP, identity and payment gates", () => {
  const config = parse(
    readFileSync(
      new URL(
        "../artifacts/api-server/.replit-artifact/artifact.toml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const api = config.services.find((service) => service.name === "API Server");
  assert.ok(api);
  for (const path of [
    "/.well-known/ai-catalog.json",
    "/mcp/server-card",
    "/server-card",
  ])
    assert.ok(api.paths.includes(path), path);
  const source = readFileSync(
    new URL("../artifacts/api-server/src/app.ts", import.meta.url),
    "utf8",
  );
  const registration = source.indexOf("registerSep2127DiscoveryRoutes(app);");
  assert.ok(registration > source.indexOf("registerPublicCors(app,"));
  for (const next of [
    "registerMcpRequestGuard(app);",
    "registerMcpRoute(app,",
    "app.use(nip98RevocationGuard);",
  ])
    assert.ok(registration < source.indexOf(next), next);
});
