---
name: Vendored archive integrity
description: Why unrelated pnpm frozen installs can fail on a local SDK archive checksum.
---

Regenerating a workspace lockfile can update the integrity of a local vendored SDK archive even when the task changes only another dependency. Avoid silently carrying that unrelated lockfile change into a narrowly scoped dependency fix.

**Why:** The checked-in archive's bytes and the existing lockfile checksum differed during a security dependency update. A full frozen install rejected the archive, while a filtered install of the affected packages succeeded.

**How to apply:** When a lockfile-only update changes local archive integrity, compare it to the existing lockfile, keep the dependency change scoped, and report the frozen-install limitation. Reconcile the archive checksum separately if a complete frozen install is required.