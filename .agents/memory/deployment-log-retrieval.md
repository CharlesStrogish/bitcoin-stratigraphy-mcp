---
name: Deployment log retrieval
description: Limits of the deployment-log fetch observed during production audits, and how to get complete coverage of a boot.
---

An unfiltered deployment-log fetch returned only the latest ~100 lines, and
queries for windows before the current deployment returned nothing (observed
2026-10-15). Regex-filtered fetches over a time range did return every match.

**Why:** a first unfiltered fetch covered only the last 14 minutes of a
90-minute boot and could have passed for complete coverage.

**How to apply:** for audits, use filtered queries for markers, and page the
full window in small slices (split any slice returning ~100 lines). Check that
the first and last timestamps span the whole window. Capture evidence from a
deployment before republishing, because it cannot be retrieved afterwards, and
local log snapshots may be cleared.
