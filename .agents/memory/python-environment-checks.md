---
name: Python environment checks
description: Interpreter alignment and TLS trust pitfalls for Python client development in this workspace.
---

Do not assume the interactive shell's `python` is the interpreter used by the
Python package installer or the uv project environment. Check imports with the
project interpreter after changing the Python module or package constraints.

**Why:** The installer successfully installed packages for one interpreter while
the shell and managed interpreter symlinks initially resolved to other versions.
Pure-Python imports appeared missing, and compiled wheels could not be shared
across those Python ABIs. Aligning the project version constraint and its Replit
Python module corrected the managed environment.

**How to apply:** Use the package-management tools for runtime/dependency changes,
then check the actual interpreter version and imports via the uv project runtime.
Do not fix compiled-wheel mismatches by pointing a different Python at another
version's site-packages directory.

Keep workspace Python import paths out of subprocesses that run Nix-managed
Python CLIs.

**Why:** Nix's OTS executable used its own interpreter but imported the workspace
Bitcoin package through inherited Python paths. That unpatched package could not
load the expected OpenSSL symbols; the Nix dependency closure worked correctly.

**How to apply:** Isolate Python import-path overrides for those subprocesses,
without stripping unrelated runtime settings or altering the parent's environment.

Use a verified system SSL context for Python HTTP clients in this environment,
not disabled certificate verification.

**Why:** HTTPX's bundled-root default failed certificate verification against the
public MCP host, while the system SSL context validated the same endpoint. The
failure occurred before HTTP negotiation and was not an MCP protocol defect.

**How to apply:** Keep TLS verification enabled and trust the configured system
or explicitly supplied CA; expose nested async transport exceptions so TLS
failures are distinguishable from protocol or payment failures.