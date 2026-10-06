---
name: Orphaned workflow processes
description: A failed managed workflow can coexist with older child servers still holding its ports.
---

After workflow reconciliation, do not assume a failed workflow means its
previous server processes exited.

**Why:** Across multiple reconciliations, older artifact servers continued
holding their ports while replacement workflows failed or Vite selected a
different port. The preview could still load the old process.

**How to apply:** Inspect process/port ownership before repeatedly restarting.
Terminate only confirmed stale processes belonging to the affected artifact,
then restart its exact managed workflow and confirm startup logs. Never kill
unrelated servers or replace managed workflows with duplicate configurations.
