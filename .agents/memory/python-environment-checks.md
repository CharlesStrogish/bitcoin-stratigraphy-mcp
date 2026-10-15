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

Package discoverability checks such as `find_spec` do not establish import or ABI
compatibility. Exercise a real import with the managed interpreter.

**Why:** A shell interpreter could find LangChain in the managed site-packages
directory but could not load its compiled Pydantic dependency for that Python ABI.

**How to apply:** Run framework cookbook tests and demos through `uv run --no-sync`
when the project environment is already installed, rather than trusting the
generic shell `python` or a successful module lookup.

Apply interpreter alignment to Node-spawned Python workers too, and test the
actual subprocess under its restricted environment rather than only in-process
Python tests or mocked HTTP handlers.

**Why:** The shell's generic interpreter was older than the managed project
runtime. Removing Replit's Python import-path settings also hid installed OTS
dependencies, causing live workers to fail despite passing Python unit tests.

**How to apply:** Select the managed project interpreter for project workers
and retain only necessary runtime/import/SSL settings. Do not forward application,
wallet or payment credentials. Check a real worker response after packaging.

Keep workspace Python import paths out of subprocesses that run Nix-managed
Python CLIs.

**Why:** Nix's OTS executable used its own interpreter but imported the workspace
Bitcoin package through inherited Python paths. That unpatched package could not
load the expected OpenSSL symbols; the Nix dependency closure worked correctly.

**How to apply:** Isolate Python import-path overrides for those subprocesses,
without stripping unrelated runtime settings or altering the parent's environment.

Under `uv run`, PATH puts the workspace environment's `ots` script ahead of
the Nix OTS CLI. That script fails with "undefined symbol: BN_add". The API
server process resolves the Nix CLI first, so production is unaffected.

**Why:** A manual CLI check run through `uv run` reached the broken workspace
script, although the server's own stamping worked.

**How to apply:** For manual or harness runs of the real CLI, remove the
workspace environment's bin directory from PATH as well as PYTHONPATH and
PYTHONHOME. Confirm with `command -v ots` that the Nix store path is used.

Use a verified system SSL context for Python HTTP clients in this environment,
not disabled certificate verification.

**Why:** HTTPX's bundled-root default failed certificate verification against the
public MCP host, while the system SSL context validated the same endpoint. The
failure occurred before HTTP negotiation and was not an MCP protocol defect.

**How to apply:** Keep TLS verification enabled and trust the configured system
or explicitly supplied CA; expose nested async transport exceptions so TLS
failures are distinguishable from protocol or payment failures.