#!/usr/bin/env bash
# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
set -euo pipefail
cd "$(dirname "$0")/.."
coverage_dir=$(mktemp -d)
trap 'rm -rf "$coverage_dir"' EXIT
export COVERAGE_FILE="$coverage_dir/.coverage"
export PYTHONPATH="$PWD/test:$PWD:${PYTHONPATH:-}"
uv run --no-sync python -m coverage run --branch --source=stratigraphy_pipeline \
  -m unittest test_stratigraphy_pipeline test_stratigraphy_rpc
uv run --no-sync python -m coverage report --fail-under=100 --precision=2 -m
