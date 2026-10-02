---
name: Smithery discovery probes
description: User-requested static discovery contract and the intentional decision to keep MCP scanner probes finite.
---

Preserve the user's exact five-field Smithery discovery response, including version `1.0.0`, independently of the engine's release version and negotiated MCP protocol version.

**Why:** The user explicitly requested that static response to prevent Smithery updates from timing out. Replacing it with richer runtime metadata or synchronizing its version would change the requested contract.

**How to apply:** Keep discovery independent of tool execution and payment. MCP GET/HEAD requests must complete promptly even when the caller advertises `text/event-stream`; do not restore an idle GET SSE stream based on Accept alone. Actual stateless MCP JSON-RPC calls continue over POST.