---
name: Dead CSS pruning
description: How to find CSS made dead by removing dashboard UI without deleting pre-existing or still-used rules.
---

Token-matching class names against the source misses dead rules in two ways:
- Common-word classes such as `signal` and `dot` stay "used" because the words
  appear elsewhere (for example `AbortController().signal`).
- Template families such as `` `chart-${id}` `` in the unused shadcn chart
  component make every `chart-*` class look used.

`pagination` looked like the same false positive, but the simulator's trace
browser still uses it.

**Why:** A first token-based pass removed 109 selectors yet left `.signal`,
`.dot` and the legacy `chart-*` rules behind.

**How to apply:**
- Scope removals to classes used at HEAD and unused now; leave pre-existing
  unused template CSS (the elevate utilities) alone.
- Back up the token pass with a stricter pass that counts whole words inside
  string literals, and review every candidate by hand.
- Compare rule lists with postcss afterwards; `diff` can misalign identical
  brace lines and suggest damage that isn't there.
