// Copyright (c) 2026 Charles R. Strogish. Dual-licensed AGPLv3 / Commercial.
// The canonical OpenAPI contract (lib/api-spec/openapi.yaml), parsed at most
// once per process. The production build embeds it as the equivalent JSON text
// (see build.mjs) because parsing 170 KB of YAML delays startup by hundreds of
// milliseconds; other builds embed the authored YAML. Every caller receives its
// own deep copy, so a module that augments its document cannot affect another.
// Keep this module free of MCP imports: agent-conversion relies on that.
import { parse } from "yaml";
import openApiSource from "../../../../lib/api-spec/openapi.yaml";

let contract: unknown;

export function readOpenApiContract(): Record<string, unknown> {
  contract ??= openApiSource.trimStart().startsWith("{")
    ? JSON.parse(openApiSource)
    : parse(openApiSource);
  return structuredClone(contract) as Record<string, unknown>;
}
