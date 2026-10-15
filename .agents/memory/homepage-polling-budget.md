---
name: Homepage polling budget
description: The API's public rate limit is per 15 minutes, shared by every free route; how much live polling the dashboard homepage may do.
---

The public limiter allows 100 requests per IP per sliding 15-minute window, not
per minute. One budget covers every route except `/mcp`, paid REST routes and
paid escrow routes: docs, cookbook downloads, discovery files and all homepage
telemetry reads draw on it together.

**Why:** At a one-minute cadence, the Command Center plus the escrow terminal's
30-second ledger poll (about 30 per window) reached about 100 requests per
window for a single open tab. Visitors would then get 429s on docs, cookbooks
and the terminal itself. Settlement polling moved to 5 minutes and provenance
to 15, which keeps one tab near 50 per window.

**How to apply:**
- Before adding or speeding up any homepage poll, recompute the per-window
  total. The Command Center tests fail above 60% of the limit.
- Local verification shares the loopback budget. Headless page loads and link
  checks exhaust it within minutes and then return 429s that look like broken
  links. Check `RateLimit-Policy` and `Retry-After`, then verify untouched
  server routes in production or wait for the window to slide.
