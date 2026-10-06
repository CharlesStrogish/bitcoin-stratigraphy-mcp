---
name: Dashboard visual standards
description: User's enterprise dark-theme, mobile containment and trust-badge requirements.
---

Force a global Dark Mode theme as the default dashboard UI. Keep text, tables
and interactive simulator elements reachable on small mobile viewports.

**Why:** The user requested enterprise visual standards.

**How to apply:** New routes must inherit the dark theme without a light first
paint. Wrap flex/grid contents and long text; use bounded internal scrolling
for tables and proof data rather than clipping content at the page boundary.

Trust badges must not imply provider-issued verification without an authentic
asset or documented source. The mcpservers.org listing's “official” designation
is not by itself proof of an embeddable “verified” seal.

**Why:** Public directory status and independently issued verification are
different claims; an enterprise trust row should not fabricate credentials.

**How to apply:** Confirm provider badge sources before embedding them. If no
official image can be confirmed, ask for the asset or label a listing link
honestly rather than minting a provider's verified badge.

Use a clean UI link/chip labelled “mcpservers.org · Official listing” for this
directory entry, not a fake SVG embed.

**Why:** The user explicitly selected the official-listing link alternative.

**How to apply:** Preserve the distinction between a linked official directory
entry and a provider-issued verification badge when updating the trust row.
