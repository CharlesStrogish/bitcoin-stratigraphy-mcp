---
name: Enterprise air-gap scope
description: Commercial deployment isolation requirements and the limits of local-node telemetry.
---

Commercial Enterprise Licenses need to support air-gapped deployments. Public
Bitcoin and price APIs must not remain strict dependencies of enterprise telemetry.

**Why:** The user explicitly requested local Bitcoin Core support for air-gapped
commercial deployments.

**How to apply:** Preserve the telemetry isolation boundary when extending local
node mode. Bitcoin Core cannot supply fiat prices, so unavailable price-derived
metrics must not justify silent public egress or fabricated quotes. Distinguish
telemetry isolation from cloud archives, timestamp calendars, relays, and wallets
when describing whether a whole deployment is air-gapped.
