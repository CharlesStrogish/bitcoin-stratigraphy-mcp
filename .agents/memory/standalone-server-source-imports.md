---
name: Standalone server-source imports
description: Why root-level scripts should not assume bundled API source asset paths resolve unchanged.
---

Root-level scripts that execute server TypeScript directly are not equivalent to running the built API bundle. Relative asset URLs written for the bundle can point at missing locations from the source tree, and the scripts package's typecheck may not own dependencies or source files imported from the API package.

**Why:** A direct source import worked for the local proof verifier but failed when dataset loading resolved its bundled-layout asset URL from the source location. A static cross-package import also widened the scripts TypeScript compilation boundary unexpectedly.

**How to apply:** For standalone agent demos, locate fixtures explicitly from the script or use a public API; keep source-only cryptographic operations separate from bundled data loading. Check runtime resolution and scripts-package typechecking independently.

OpenAPI-aware route tests import authored YAML through their configured
bundler loader. Directly invoking them with tsx fails before execution because
Node does not load YAML as a module.

**Why:** The API's test runner supplies asset loaders that direct TypeScript
execution does not reproduce.

**How to apply:** Use the package test runner for route tests that import the
OpenAPI document; reserve direct tsx runs for source-only modules without bundled
asset imports.