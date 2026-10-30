---
name: Node test bundle locations
description: Avoid false missing-file errors when running isolated bundled tests.
---

Keep generated test bundles outside `node_modules` when invoking `node --test`.
The test runner can exclude that directory even for an explicitly supplied file.

**Why:** An isolated bundle under `node_modules/.cache` existed on disk but
`node --test` reported it missing; direct Node execution successfully ran its
`node:test` cases.

**How to apply:** Prefer an ignored package-local generated-output directory
outside `node_modules`, retaining package dependency resolution. Do not rebuild
the shared API distribution concurrently with the workspace test runner.
