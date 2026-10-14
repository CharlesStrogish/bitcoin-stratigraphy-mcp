---
name: Formatting baseline
description: Why the combined format check fails on untouched files and how to keep changes from adding to it.
---

The combined Prettier/ruff format check already failed on many committed files, including escrow custody Python modules, before the canonical-domain release. Format only files you create or touch, and only when they were formatted before your edit.

**Why:** Mass reformatting would bury audit diffs and rewrite escrow code the user protects. The inherited debt was deliberately left in place and reported.

**How to apply:** Compare the committed blob through the formatter's stdin mode (`git cat-file -p HEAD:<path> | prettier --check --stdin-filepath <path>`, or ruff's `--stdin-filename`) to separate new regressions from inherited debt. Reformat the whole repository only when the user asks.
