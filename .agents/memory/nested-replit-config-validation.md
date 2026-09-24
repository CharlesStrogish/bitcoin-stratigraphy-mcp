---
name: Nested Replit config validation
description: Scope of the protected .replit replacement tool for standalone templates.
---

Do not use the workspace's .replit validation-and-replacement callback to create a nested template's `.replit`. Its temp path specifies only the source bytes; the destination is always the workspace root `.replit`.

**Why:** A probe with an identical copy of the root configuration placed inside the template changed the root file and created no nested config. Direct patches to both `.replit` and `replit.nix` are rejected as protected files.

**How to apply:** Preserve the root app configuration. Keep template config examples for users to activate in their separate fork; do not claim the nested active files exist until a supported nested-config mechanism is available.