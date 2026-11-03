---
name: SDK terminal output
description: User-confirmed output-channel constraint for agent-yield terminal receipts.
---

Keep SDK terminal receipts on stderr, not stdout.

**Why:** The user explicitly confirmed that “The stderr logging implementation is perfect for preserving MCP JSON-RPC integrity.”

**How to apply:** Preserve this channel when changing receipt formatting or adding SDK diagnostics, so stdout remains usable for machine-readable protocol output.
