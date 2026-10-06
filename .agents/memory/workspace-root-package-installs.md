---
name: Workspace-root package installs
description: How to handle dependency installation at this pnpm workspace root.
---

The managed package installer invokes `pnpm add` without the workspace-root flag, so adding a dependency to the root fails unless pnpm's workspace-root check is explicitly relaxed for the install.

**Why:** The installer cannot accept command-line flags as package names, and pnpm rejects an implicit root add in a workspace.

**How to apply:** Temporarily enable `ignore-workspace-root-check` in `.npmrc`, run the managed installation, then remove that temporary setting and verify the manifest and lockfile remain consistent.

Verify the installed dependency tree as well as the lockfile after a managed install.

**Why:** The managed installer updated a transitive security pin and lockfile while
the installed Express dependency still resolved the older vulnerable package.
A frozen dependency reconciliation was needed to update the running environment.

**How to apply:** Check the actual package resolved by its consumer. If it differs
from the regenerated lockfile, run the existing dependency reconciliation script
before building or restarting services. Do not add an unused direct dependency
just to trigger lockfile regeneration.

Check for stale service processes after automatic package-install workflow reboots.

**Why:** Older server processes survived one automatic reboot, held their ports,
and caused the newly tracked workflows to fail or silently choose a different port.

**How to apply:** Identify the processes holding the configured ports, stop only
confirmed stale instances, then restart the existing managed workflows once.