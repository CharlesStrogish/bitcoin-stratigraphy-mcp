---
name: API server shared dist directory
description: Why pnpm test and the API Server workflow must not run builds at the same time.
---

The API Server workflow build and the api-server test runner both write to `artifacts/api-server/dist`.
The workflow build deletes the whole directory first, and the test runner deletes its bundles and
`dist/zk` when it finishes.

**Why:** restarting the workflow during a `pnpm test` run deleted an already-built test bundle, and the
suite failed with "Could not find ./dist/provenancePersistence.unit.test.js" although every test that
ran passed. The test cleanup also removes the running dev server's zk verifier files.

**How to apply:** do not restart the API Server workflow while `pnpm test` runs. Restart it after the
suite finishes so the dev server has its zk artifacts again. Treat a "Could not find ./dist/..." line as
this collision, not as a test failure, and re-run the suite.
