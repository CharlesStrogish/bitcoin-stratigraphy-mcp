---
name: OpenTimestamps dependency choice
description: Why the TypeScript notary uses the official Python OpenTimestamps implementation.
---

Keep Python OpenTimestamps runtime support for the notary unless a safe JavaScript replacement has been verified.

**Why:** Installing the latest JavaScript opentimestamps package (0.4.9) was blocked by the package firewall at its legacy form-data dependency (2.3.3). The user explicitly allowed the official Python equivalent. Python core/calendar modules successfully produced and deserialized a real public-calendar receipt.

**How to apply:** Do not bypass the firewall or remove Python support merely because the API is TypeScript. Reconsider the JavaScript package only after checking that a maintained release has safe dependencies.