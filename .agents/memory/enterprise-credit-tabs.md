---
name: Enterprise credit tab policy
description: User-authorized deferred MCP billing, authenticated paid-history qualification and financial isolation.
---

More than 50 distinct successfully settled NIP-98-bound L402 invoices qualifies
an identity for a shared credit tab. Fifty is not sufficient; repeated uses of a
batch pass are not additional contracts. Use only verified buyer-bound historical
settlements, never self-declared agent IDs, quotes or paid execution counts.

**Why:** The user explicitly requested algorithmic credit for high-reputation
identities while preserving the upfront Hashcash/L402 barrier for everyone else.

**How to apply:** Require fresh request-bound NIP-98 on every credit admission and
repayment. Cap one identity's unpaid debt at 2,000 sats across workers and sessions.
Reserve debt and the signed event's one-time admission before execution; failed
or interrupted admitted work remains owed, like prepaid admission. Never use a
fabricated paid payment hash for deferred execution.

Explicit close ends the session; 15 minutes of inactivity or a routing allocation
change also freezes the whole tab. HTTP connection closure is not a reliable
session-end signal. Frozen tabs cannot accept further credit work until their
exact, identity/provider/asset-bound macro-invoice is verified and durably applied.
Existing prepaid passes retain their original rights.

**Why:** Stateless MCP connections do not identify business-session boundaries.
Allowing a new tab per connection or changing a frozen invoice's balance would
permit evasion of the credit ceiling and ambiguous partial repayment.

**How to apply:** Keep pending invoices durable and retryable, clear debt exactly
once, and never let an old repayment clear a new session. Expired authentic macro
credentials may confirm only their exact historical debt; they grant no tool
access. Preserve the same 79/21 pool (including nested referral routing), use
integer-msat accounting, and never count unpaid debt as received revenue or make
automatic payouts. Do not change canonical tools, UI layout, Hashcash or the
existing Nostr broadcast implementation for this feature.

Keep deferred tolls separate from settled amounts in execution evidence, so
existing paid-receipt broadcasters cannot mislabel unpaid work as settled.
Repayment responses are terminal and Lightning-only, not per-tool x402 quotes.

**Why:** Payment-response decorators may send JSON asynchronously; headers-sent
checks alone are not an admission decision.

**How to apply:** Branch on an explicit admission outcome, and preserve the
standard lane's response handling and broadcaster unchanged.

Tests using the shared PostgreSQL credit history need unique invoice hashes and
identity-scoped cleanup across runs.

**Why:** Deterministic mock preimages collide with durable records from other
tests or earlier runs; rejecting an invoice reused by another buyer is correct.

**How to apply:** Randomize mock invoice preimages rather than weakening payment
ownership or trusting a repeated invoice as another successful contract.

Fleet delegation authorizes distinct NIP-98 Worker identities to spend a VIP
Commander's master credit tab. The 2,000-sat ceiling applies to the combined
Commander and fleet, not separately to each key. Workers cannot administer the
fleet, settle the master invoice, redirect its payout allocation or transfer
their commercial exemption to the Commander. Removing a Worker prevents new
admissions but does not erase already admitted debt.

**Why:** The user authorized centralized swarm delegation, not transfer of
billing ownership, settlement authority or licensing identity.

**How to apply:** Keep one Commander per Worker and reject nested fleets.
Separate the authenticated execution identity from the billing owner. Both
invoice issuance and macaroon construction must run under the same billing-owner
economics context; otherwise a Worker-triggered macro-invoice conflicts with the
Commander's buyer binding. Never inherit a Worker's licensing account or payout
headers when issuing the master invoice.

Verified VIP macro-payments earn exactly 21% of actual paid sats as forward
treasury credit, once per settlement. Discounted gross usage is not paid volume:
a 2,000-sat payment earns 420 sats, the next 2,000-sat gross tab invoices 1,580,
and that payment earns 331.8 sats. Spending treasury credit does not itself earn
yield, reputation or cash revenue.

**Why:** The user requested compound yield rollover while explicitly protecting
Fleet Routing and its existing shared admission ceiling.

**How to apply:** Preserve the 2,000-sat gross usage ceiling; keep treasury and
signed net balance separate from that admission counter. Track yield exactly in
integer millisats. Existing wallet/revenue ledgers use whole sats, so apply
whole-sat invoice discounts and retain fractional-sat treasury remainders.
Credit-only closures consume treasury without issuing zero-value invoices.
Freeze each invoice's gross usage and applied discount; old proofs must not
clear new usage, re-spend treasury or mint additional yield.
