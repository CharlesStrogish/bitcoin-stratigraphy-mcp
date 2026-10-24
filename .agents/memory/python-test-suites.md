---
name: Python test suites
description: Where the Python suites live and how to run them, since the root Node test command runs none of them.
---

`pnpm test` runs only Node tests. A full verification must run each Python
suite separately with the project interpreter (`uv run --no-sync`):
- Root suite: discover with `PYTHONPATH=tests:.:sdk/python`, using plain module
  names. A `test.`-prefixed name resolves to the standard library's `test`
  package.
- `routers` and `services`: run as packages from the root, with
  `PYTHONPATH=sdk/python:.`.
- `cookbooks`: discover from inside that directory with
  `PYTHONPATH=../sdk/python:..`. Without it, the enterprise package tests fail
  with 17 import errors.
- Framework quickstarts require a separate discovery from inside their directory;
  ordinary cookbook discovery does not recurse into a namespace-only subdirectory.
- `scripts`: `scripts.test_verify_agent_routes`, from the root.
- SDK: `test_client`, from inside `sdk/python` with `PYTHONPATH=../..`. It
  imports `sdk.python.client`, so without it the import fails.
- `scripts/test-stratigraphy-coverage.sh`: the 100% stratigraphy pipeline
  coverage gate.

**Why:** Each suite needs a different import root. The coverage gate and the
Python suites are not wired into the Node commands. A green `pnpm test` says
nothing about Python.

**How to apply:** After Python changes, run all of the above plus
`pnpm lint:python`. Also confirm the coverage gate independently (see
stdlib-trace-coverage.md).
