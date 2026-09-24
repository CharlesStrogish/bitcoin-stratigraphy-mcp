---
name: ElizaOS type-only dependency
description: Why the plugin's local development dependency prunes ElizaOS browser crypto without changing its public peer contract.
---

The ElizaOS plugin imports core types only; its own runtime does not load core. The development install can omit core's browser-crypto dependency because the upstream elliptic package has no published patched release. Preserve the public ElizaOS peer dependency so consumers continue to supply their own complete installation.

**Why:** A global substitution with another crypto library would change an unrelated library's runtime semantics; a narrowly scoped removal from the type-only development dependency removes the vulnerable transitive chain without rewriting cryptography.

**How to apply:** If the plugin begins importing ElizaOS values at runtime, or if this workspace starts executing the installed core package, revisit the scoped removal before relying on those code paths. Do not copy the override into consumer applications that execute ElizaOS core in browsers.