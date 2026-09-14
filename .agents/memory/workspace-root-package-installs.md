---
name: Workspace-root package installs
description: How to handle dependency installation at this pnpm workspace root.
---

The managed package installer invokes `pnpm add` without the workspace-root flag, so adding a dependency to the root fails unless pnpm's workspace-root check is explicitly relaxed for the install.

**Why:** The installer cannot accept command-line flags as package names, and pnpm rejects an implicit root add in a workspace.

**How to apply:** Temporarily enable `ignore-workspace-root-check` in `.npmrc`, run the managed installation, then remove that temporary setting and verify the manifest and lockfile remain consistent.