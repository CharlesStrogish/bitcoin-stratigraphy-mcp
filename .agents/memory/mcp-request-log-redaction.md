---
name: MCP request log redaction
description: Why request logging must omit URL query strings, and how to handle historical logs.
---

Log request paths, not raw URLs or query strings, for MCP traffic and any other credential-capable endpoint.

**Why:** Historical deployment logs contained a credential-shaped query parameter despite separate structured request logging already stripping query strings. Fixing the logger prevents future entries but does not remove older ones.

**How to apply:** When changing request instrumentation, verify both structured and manual logs using a harmless query marker. Treat older logs as sensitive until affected credentials and retention are reviewed; never quote their values.

Crawler radar is best-effort observation, never authentication or payment policy.

**Why:** The user requires traffic visibility without changing payment gates or responses. User-Agent signatures are self-declared and do not establish an agent's identity. Logging failures must not become request failures.

**How to apply:** Keep telemetry deferred, bounded, and failure-contained; do not add per-request database or network waits. Observe requests reaching the API only. Do not reroute frontend-served robots or sitemap documents merely to make them visible to Express.