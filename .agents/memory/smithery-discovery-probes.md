---
name: Smithery discovery probes
description: User-requested static discovery contract and the intentional decision to keep MCP scanner probes finite.
---

Keep Smithery discovery static, public, and independent of the negotiated MCP protocol version. Registry release metadata may include the canonical tool count and tool annotations.

**Why:** The user originally requested a minimal card to prevent scanner timeouts, then explicitly requested expanded release metadata and version synchronization. Preserve prompt responses without live tool execution or payment checks.

**How to apply:** Keep discovery independent of tool execution and payment. MCP GET/HEAD requests must complete promptly even when the caller advertises `text/event-stream`; do not restore an idle GET SSE stream based on Accept alone. Actual stateless MCP JSON-RPC calls continue over POST.

The user requested wildcard CORS across all server routes and immediate successful OPTIONS responses.

**Why:** Smithery's browser interface must be able to read the public API across origins without CORS blocking.

**How to apply:** Do not restore reflected origins with credentialed cookie CORS. Preflights terminate before parsing or payment checks. Preserve wildcard allowed headers, but explicitly allow Authorization when requested because browsers do not include it in the wildcard.