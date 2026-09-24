---
name: Git subdirectory SDK installs
description: Why pnpm Git dependency preparation can pick up the wrong workspace or reject SDK builds.
---

When distributing a source-only package from a Git monorepo subdirectory, keep a workspace manifest in the Git repository and require consumers to allow its package build scripts. A prebuilt archive avoids both requirements for standalone templates.

**Why:** pnpm 10 rejects Git dependency preparation by default unless the consumer trusts that package. In a nested package checkout without its own workspace boundary, pnpm may traverse upward into the hosting Repl's workspace when installing build dependencies, then fail to prepare the cloned package even though it builds in the source workspace.

**How to apply:** For Git-based SDK consumers, verify install from a clean repository clone with the repository's workspace manifest and the consuming project's build-script allowlist. For one-click standalone forks without a known Git remote, ship a versioned prebuilt package archive instead of a workspace-only reference.