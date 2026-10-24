#!/usr/bin/env bash
# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
export PYTHONPATH="$root/tests:$root/sdk/python:$root:${PYTHONPATH:-}"

uv run --no-sync python -m unittest discover -s tests -p 'test_*.py'
uv run --no-sync python -m unittest discover -s routers -p 'test_*.py'
uv run --no-sync python -m unittest discover -s services -p 'test_*.py'
(
  cd cookbooks
  uv run --no-sync python -m unittest discover -s . -p 'test_*.py'
)
(
  cd cookbooks/frameworks
  uv run --no-sync python -m unittest discover -s . -p 'test_*.py'
)
uv run --no-sync python -m unittest scripts.test_verify_agent_routes
(
  cd sdk/python
  uv run --no-sync python -m unittest test_client
)
