---
name: Catalog block index
description: Meaning and limits of block bounds exposed by MCP dataset discovery and range queries.
---

Treat historical catalog block bounds as a deterministic daily index: anchor the newest snapshot at block 920,000 and step backward by 144 blocks per recorded day.

**Why:** The source dataset records daily epochs but contains no native Bitcoin block height. A deterministic index supports stable discovery and filtering without presenting fabricated per-record measurements as observed chain data.

**How to apply:** Describe these values as an index in schemas and responses. If real source block heights are later added, migrate the catalog and range filters together and preserve compatibility deliberately.