---
name: Npm server distribution
description: Distribution boundaries and safe validation of the enterprise MCP npm runtime.
---

The npm server release is a self-hosted Streamable HTTP engine with its required
workers, proof assets, and licensed Python companion, not a thin remote connector.
Keep the monorepo workspace private and stage an explicit allowlisted distribution.

**Why:** The user requested the latest live-settlement and Sovereign Node
architecture as a minimal npm package. Publishing the whole workspace exposes
unrelated development material; publishing only a connector omits that architecture.

**How to apply:** Preserve the distribution boundary and disclose runtime
prerequisites rather than weakening license checks or persistence requirements to
make discovery start. Npm publication is separate from deployment and registry
refresh for the existing remote HTTP listings.

Block outbound networking when boot-testing a production-mode npm runtime with
fixture signing credentials.

**Why:** Server startup can announce its identity automatically to real Nostr
relays. A fixture key must not advertise a pretend production service.

**How to apply:** Test isolated package startup with explicit fixture-only
environment settings and deny egress before application import; never inherit
workspace wallet/signing credentials into that smoke process.

Contractual service guarantees are not an included enterprise feature; do not advertise them
as such in the npm package README.

**Why:** The user identified the enterprise support-guarantee bullet as inaccurate and requested removing related wording from project documentation.

**How to apply:** Preserve this exclusion when editing the package's enterprise documentation.

Serialize release builds and API workflow restarts against backend test runs.

**Why:** These operations share generated runtime output. A concurrent build
can delete compiled tests while the runner is executing, producing missing-file
failures unrelated to application regressions.

**How to apply:** Finish builds and server restarts before starting backend tests,
or wait until tests finish before building again.
