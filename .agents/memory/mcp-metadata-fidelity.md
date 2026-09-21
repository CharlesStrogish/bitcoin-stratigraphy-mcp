---
name: MCP metadata fidelity
description: Rules for improving MCP discovery quality without creating schema or behavior drift.
---

MCP quality-score work must preserve contract fidelity: metadata, JSON Schema, and Zod validators should describe the fields, outputs, execution model, and side effects the handlers actually implement. Do not add rubric example fields as metadata-only aliases.

**Why:** Generic optimization guidance may assume asynchronous jobs, pagination fields, or proof shapes that differ from this server. Advertising unsupported fields would improve superficial metadata while breaking agents at runtime.

**How to apply:** Keep tool names and return payloads stable unless explicitly migrating the contract. Add requested constraints to real fields, implement additive inputs end-to-end when safe, and describe actual synchronous/stateful behavior.