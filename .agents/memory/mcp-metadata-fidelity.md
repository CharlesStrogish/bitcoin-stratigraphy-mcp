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

For description-only quality work, verify semantic coverage and exact contract parity rather than enforcing a fixed sentence count or incidental prose phrases. When a tool has a user-specified leading sentence, keep that sentence intact and adapt old prose-pattern assertions to allow it.

**Why:** Earlier description tests encoded a previous writing style and rejected accurate, structured purpose/usage/consequences guidance even though the advertised behavior was unchanged. New tool descriptions with exact requested lead-ins can encounter the same issue.

**How to apply:** Check every advertised tool has truthful boundaries, usage guidance, cost and failure notes, and that shared metadata matches; retain independent assertions for critical facts and exact tool count.

When evaluator-suggested wording conflicts with real credential or payload behavior, prefer accurate copy over literal phrasing. The user approved substituting truthful descriptions rather than advertising unsupported guarantees.

**Why:** Security claims such as non-expiring, non-revocable credentials and payload claims such as raw block bodies or header-only digests could mislead callers even if they improve a rubric score.

**How to apply:** Verify claimed revocation, expiration, retention, and payload semantics against handlers and schemas before publishing metadata; ask for clarification when exact requested copy would be false.

The developer portal must document the existing canonical tool catalog, not
introduce the descriptive tool names from the initial portal request as aliases.

**Why:** The user explicitly selected the existing 14 live tools after being told
the requested names included unregistered operations and new payment behaviors.

**How to apply:** Load discovery schemas from the live server. Treat requested
names as explanatory intent mappings where accurate, clearly label unsupported
operations, and do not add API or payment behavior just to match a docs label.

Do not assume a discovery manifest's protocol-version string is accepted by the
runtime MCP transport.

**Why:** Discovery advertised a date-like version the installed MCP SDK rejected
with HTTP 400, even though a supported Streamable HTTP version worked.

**How to apply:** Initialize with a supported protocol version, verify the
negotiated response, and keep the MCP-Protocol-Version header consistent with it.
Check the runtime SDK's supported versions before diagnosing a transport outage.

Descriptive names explicitly requested for HTTP cost discovery may be accepted
as quote-only selectors, but must not become callable MCP aliases implicitly.
Batch totals are estimates for separate tool calls, not aggregate entitlements.

**Why:** The requested cost payload uses descriptive operations while the public
catalog must retain its 14 canonical tools. Paid credentials are path-bound and
single-use, so a sum of prices cannot authorize multiple tool executions.

**How to apply:** Return canonical execution names and per-tool L402 generation
instructions. Keep quotes invoice-free, preserve original scopes for existing
executable aliases, and distinguish the aggregate quote from actual settlement.