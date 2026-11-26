import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "@iarna/toml";

test("API artifact explicitly owns MCP and A2A discovery before identity and payment gates", () => {
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
    "/.well-known/agent-card.json",
    "/.well-known/jwks.json",
  ])
    assert.ok(api.paths.includes(path), path);
  const source = readFileSync(
    new URL("../artifacts/api-server/src/app.ts", import.meta.url),
    "utf8",
  );
  const registration = source.indexOf("registerSep2127DiscoveryRoutes(app);");
  const a2aRegistration = source.indexOf(
    "registerA2aDiscoveryRoutes(app, toolIntegrityKey);",
  );
  assert.ok(registration > source.indexOf("registerPublicCors(app,"));
  assert.ok(a2aRegistration > source.indexOf("registerPublicCors(app,"));
  assert.equal(
    source.match(/const toolIntegrityKey = loadToolIntegrityKey\(\);/g)?.length,
    1,
  );
  assert.ok(
    source.includes(
      "registerToolIntegrityRoute(app, mcpToolDefinitions, toolIntegrityKey);",
    ),
  );
  for (const next of [
    "registerMcpRequestGuard(app);",
    "registerMcpRoute(app,",
    "app.use(nip98RevocationGuard);",
  ]) {
    assert.ok(registration < source.indexOf(next), next);
    assert.ok(a2aRegistration < source.indexOf(next), next);
  }
});
