---
name: MCP request log redaction
description: Why request logging must omit URL query strings, and how to handle historical logs.
---

Log request paths, not raw URLs or query strings, for MCP traffic and any other credential-capable endpoint.

**Why:** Historical deployment logs contained a credential-shaped query parameter despite separate structured request logging already stripping query strings. Fixing the logger prevents future entries but does not remove older ones.

**How to apply:** When changing request instrumentation, verify both structured and manual logs using a harmless query marker. Treat older logs as sensitive until affected credentials and retention are reviewed; never quote their values.