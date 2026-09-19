---
name: SNARK worker bundling
description: Build and lifecycle constraints for worker-spawning zero-knowledge cryptography libraries.
---

Keep libraries that discover worker entrypoints from their own module filenames external to esbuild server and test bundles. Test processes may explicitly terminate their cryptographic worker pools; long-running servers should retain warmed pools.

**Why:** Bundling can rewrite the worker entrypoint to the surrounding test or server bundle, recursively executing tests or startup code. Unconditional teardown also makes every production verification pay cold initialization cost.

**How to apply:** When changing API/test bundling or cryptography dependencies, verify worker-spawning packages remain external and keep teardown conditional on the test environment. Pre-warm with a known valid proof before listening. Self-verify newly generated proofs before returning them, then cache only that successful verification so their first external check is fast without weakening integrity.