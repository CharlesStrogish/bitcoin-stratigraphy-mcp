---
name: MCP optional response fields
description: Compatibility rules for validating live MCP tool metadata and successful call results.
---

Treat an omitted JSON Schema `required` property as an empty list, and treat an omitted MCP tool-result `isError` property as success unless it is explicitly `true`.

**Why:** The live MCP SDK legitimately omits `required` for tools with no required arguments and omits `isError` on normal successful results. Requiring either field caused valid live responses to fail health checks.

**How to apply:** When writing MCP clients or external health checks, validate declared required properties when present and reject tool execution only when `isError === true` or a JSON-RPC error is returned.