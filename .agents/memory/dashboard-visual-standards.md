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

The user designated the supplied dark rounded tile with a white “M” and amber
“CP” as this project's official MCP logo.

**Why:** The user supplied it as “our official MCP logo.”

**How to apply:** Use the supplied mark for this project's MCP branding rather
than inventing a replacement. It is project branding, not a protocol-wide
certification or a third-party verification seal.

The Live REST Escrow terminal must sit directly below the hero, trust badges
and quick-action grid, above the Enterprise & Machine-Native Command Center.
The user explicitly removed the four legacy archive KPI cards and all
archive-count / Uploaded JSON badges from the homepage. Preserve the hero,
trust badges and terminal. `/#live-escrow-terminal` is its
stable deep link, used by the header quick action and the compliance page CTA.

**Why:** The user asked (2026-10-15) for visitors to see the terminal
immediately and to land on it directly from other pages.

**How to apply:** Keep this placement and anchor when reorganizing the
homepage, and point any new link to the terminal at `/#live-escrow-terminal`.

On the Enterprise Preview page, prioritize the Live REST Escrow terminal above
the synthetic agent simulation. Keep the Article 12 compliance-guide link as
a bridge into the simulation, with breathing room below the live terminal.

**Why:** The user requested this ordering to optimize enterprise conversion.

**How to apply:** Preserve this live-first hierarchy when reorganizing the
preview; it is separate from the homepage placement rule above.
