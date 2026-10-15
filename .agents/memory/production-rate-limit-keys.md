---
name: Production rate-limit keys
description: How production requests reach the API (forwarded-address chain), how clients and platform probes are keyed, what to check after a publish, and how to read rate-limit refusals in deployment logs.
---

Evidence gathered 2026-10-15 on the production Reserved VM (`trust proxy` 1):

- External requests carry `via: 1.1 google`. The rightmost X-Forwarded-For entry
  is a rotating Google front end (35.191.0.0/16, also 130.211.0.0/22) appended
  by Replit's router, so keying on Express's `req.ip` gave every request an
  almost fresh bucket. Per Google's documentation the chain is
  `[caller-supplied…], client, load balancer, front end`; the client sits at
  [-3]. The load-balancer hop at [-2] was inferred from those docs, not observed.
- Platform health/discovery probes arrive from loopback with no X-Forwarded-For.
  They hit every service path in pairs 80 s apart every 5 minutes, plus ~75
  boot-time checks. When probes shared one budget, they were refused for
  ~14 minutes after each boot.

Since 2.1.3, clients are keyed on the [-3] entry only when Express accepted a
Google front end from the trusted router. Probe reads are exempt only in
published deployments (`REPLIT_DEPLOYMENT=1`). Refusals log at warn as "request
rate limited", with a per-boot client reference and never an address.

**Why:** an audit based on request logs once reported green while probes were
being refused, and the user asks for verified, fully green production checks
after each publish.

**How to apply:**
- After publishing, find the one-time "client address chain check" line. A
  `confirmed` layout supports the [-3] rule. `unexpected` (short chains or a
  widely varying load-balancer hop) means re-examine the chain before trusting
  per-client budgets. Never change `trust proxy` without re-verifying the chain.
- Accurate keys made per-client caps effective for the first time, including
  the public 100 per 15 minutes and unpaid L402 challenge issuance (10 per
  minute per paid tool). Paid swarms (enterprise-swarm-traffic.md) should use
  batch passes. Credentialed paid retries never reach these limits.
- Logs from boots before 2.1.3 still hide public-limiter 429s: treat missing
  burst paths there as possible unlogged refusals.
