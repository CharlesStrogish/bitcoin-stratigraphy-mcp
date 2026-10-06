---
name: Enterprise SDK compatibility boundaries
description: Why legacy aliases and independently staged audit workers matter during SDK migration.
---

Legacy cookbook imports must preserve module identity with the canonical SDK
implementation, not merely re-export its classes/functions.

**Why:** Existing tests and integrations patch symbols through legacy module
paths. A simple re-export leaves implementation globals in another namespace,
so patches can miss the actual transport or verification function.

**How to apply:** Preserve legacy patch bindings when moving implementation
modules; check identity and mocked paid/offline behavior through both namespaces.

Verify deployed audit-worker imports independently of the checkout. Keep the
SDK namespace lazy and bundle the worker's actual dependency closure.

**Why:** The server build stages an allowlisted Python worker, not the whole
repository. Checkout imports can succeed while deployment imports fail.
Eager framework imports also add unnecessary work to a memory-bounded,
independent auditing process.

**How to apply:** After package-layout changes, test the staged worker outside
the repository and avoid relying on workspace-only paths or optional frameworks.
