---
name: MCP schema metadata
description: How to expose complete MCP tool schemas with this project's Zod and MCP SDK versions.
---

Publish explicit JSON Schemas from the low-level MCP list-tools handler, and validate tool-call arguments separately with Zod.

**Why:** The installed Zod 3 API can emit descriptions but has no metadata API for examples, so the MCP SDK's automatic Zod-to-JSON-Schema conversion cannot produce the schema examples required by quality scanners.

**How to apply:** Keep list-tools schemas and runtime validators aligned through contract tests that recursively require types, descriptions, and examples and exercise every registered tool. Multi-format payment tests need an isolated MCP app/server: the shared contract-test server has the production 60-requests-per-minute limit, and extra calls can cause unrelated later tests to return 429.