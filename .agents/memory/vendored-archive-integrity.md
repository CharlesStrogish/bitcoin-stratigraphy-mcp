---
name: Vendored archive integrity
description: Why unrelated pnpm frozen installs can fail on a local SDK archive checksum.
---

The integrity recorded for a local vendored SDK archive must match the exact committed archive bytes. A dependency-only lockfile update may expose a pre-existing mismatch; do not treat a filtered install as proof that the full workspace can install.

**Why:** A security dependency update merged successfully, but post-merge frozen installation failed because the local archive's checksum differed from its lockfile entry. Reconciliation of the committed archive and lockfile restored frozen installs.

**How to apply:** Before merging a lockfile change, verify a full frozen install, including local archives. If an archive changes, confirm its provenance and update its lockfile checksum to its actual bytes; never disable integrity checking or silently skip the archive.