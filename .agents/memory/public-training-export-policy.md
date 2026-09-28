---
name: Public training export policy
description: Access and provenance choices for machine-ingestible Bitcoin Stratigraphy exports.
---

Keep the machine-ingestible historical dataset export and its crawler schema manifest publicly accessible without L402, while interactive MCP dataset queries remain paid. Do not add a payment challenge to the export as part of general API paywall work.

**Why:** The user explicitly chose unrestricted crawling, indexing, and fine-tuning ingestion even though the underlying dataset is also sold through interactive endpoints. The historical records have derived daily index labels and source fingerprints, but no per-record ZK proofs; the training examples must not teach those as independently measured block facts or cryptographic proofs.

**How to apply:** When adding export formats or crawler metadata, retain the public access policy and clearly identify indexed labels, target-distance proxies, and unavailable per-record proofs. Keep separate paid MCP behavior unchanged unless the user explicitly revises it.