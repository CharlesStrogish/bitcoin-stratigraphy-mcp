---
name: Enterprise pipeline metric policy
description: User-defined meaning of the Hal Finney Horizon and the network-power model.
---

The enterprise pipeline's Hal Finney Horizon is the price multiple
$10,000,000 / current Bitcoin USD price, not a halving deadline or a days-remaining
forecast. Preserve the user's historical attribution verbatim and immediately
after the multiple in JSON.

Network power uses the assumed fixed modern-hardware baseline of 15 J/TH.
It is estimated joules per second, not directly measured electricity or a
Landauer-limit thermodynamic calculation.

**Why:** The user supplied these exact mathematical and historical models to
resolve the earlier ambiguous horizon and energy requirements.

**How to apply:** Keep these definitions and the attribution requirement when
extending enterprise telemetry. Do not silently substitute a different horizon,
efficiency assumption, physical measurement claim, or time-to-price prediction.
