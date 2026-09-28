---
name: x402 paid MCP settlement
description: Settlement ordering and readiness policy for x402 on paid MCP tools.
---

For paid MCP tools, x402 must use an upfront payment flow and settle successfully before executing the tool. Advertise x402 alongside L402 only after the authenticated facilitator confirms it supports the intended network and scheme. If unavailable, keep free discovery and the existing L402 rail working.

**Why:** Some MCP tools have side effects, so a default post-handler settlement could perform work before a payment is confirmed. Advertising a rail merely because credentials exist can promise payments that a broken or unsupported facilitator cannot process.

**How to apply:** Preserve this ordering when adding paid tools or changing the facilitator, challenge format, or payment SDK. Test rejected and repeated settlement attempts before granting access.