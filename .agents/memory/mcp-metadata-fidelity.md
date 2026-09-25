---
name: MCP metadata fidelity
description: Rules for improving MCP discovery quality without creating schema or behavior drift.
---

MCP quality-score work must preserve contract fidelity: metadata, JSON Schema, and Zod validators should describe the fields, outputs, execution model, and side effects the handlers actually implement. Do not add rubric example fields as metadata-only aliases.

**Why:** Generic optimization guidance may assume asynchronous jobs, pagination fields, or proof shapes that differ from this server. Advertising unsupported fields would improve superficial metadata while breaking agents at runtime.

**How to apply:** Keep tool names and return payloads stable unless explicitly migrating the contract. Add requested constraints to real fields, implement additive inputs end-to-end when safe, and describe actual synchronous/stateful behavior.

For an explicit MCP tool rename, advertise only the canonical name, but keep the old name callable and preserve its original paid L402 scope and price. Verify the published OpenAPI/SDK schemas against the live tool registry rather than inventing a plausible response shape.

**Why:** Previously issued paid credentials must remain valid for legacy callers without letting an alias bypass payment. A convincing but incorrect receipt field or omitted lookup selector can make a schema-validating client reject actual server responses.

**How to apply:** Update discovery, server cards, cost metadata, docs, SDK helpers, gate lookup, and handler dispatch together; compare canonical descriptions and input/output schemas end-to-end, and test legacy and canonical payments independently.