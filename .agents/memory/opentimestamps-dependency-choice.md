---
name: OpenTimestamps dependency choice
description: Why the TypeScript notary uses the official Python OpenTimestamps implementation.
---

Keep Python OpenTimestamps runtime support for the notary unless a safe JavaScript replacement has been verified.

**Why:** Installing the latest JavaScript opentimestamps package (0.4.9) was blocked by the package firewall at its legacy form-data dependency (2.3.3). The user explicitly allowed the official Python equivalent. Python core/calendar modules successfully produced and deserialized a real public-calendar receipt.

**How to apply:** Do not bypass the firewall or remove Python support merely because the API is TypeScript. Reconsider the JavaScript package only after checking that a maintained release has safe dependencies.

Use official OpenTimestamps core primitives for asynchronous server stamping
rather than importing the wallet-oriented CLI modules.

**Why:** On this Nix Python runtime, importing `otsclient.ots` eagerly imports
Bitcoin RPC/key support; OpenSSL library discovery failed and attempted to
resolve `BN_add` from the Python executable. Core serialization, hashing and
calendar definitions work without those wallet imports.

**How to apply:** Use bounded asynchronous HTTP calendar submission around the
official core library. Do not assume the local `ots` CLI works merely because
its package is installed; verify OpenSSL discovery before using it. Independent
clients can use their own working CLI and Bitcoin node.