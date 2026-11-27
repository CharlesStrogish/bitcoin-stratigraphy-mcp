---
name: Filtered install peer links
description: Workspace relinking after a filtered dependency addition changes optional-peer resolution.
---

After a filtered package addition introduces a provider for an existing optional
peer, run a full `pnpm install --frozen-lockfile` before whole-workspace tests.

**Why:** Adding the storage client introduced a Google auth provider that changed
OpenAI's peer-qualified package paths. Packages outside the filter retained
symlinks to removed paths, causing unrelated module-not-found and type errors.
A full frozen install restored the links without changing their manifests.

**How to apply:** If unrelated workspace modules disappear after a filtered
install, inspect the symlink targets and relink the existing lockfile instead of
changing application types or upgrading unrelated packages.
