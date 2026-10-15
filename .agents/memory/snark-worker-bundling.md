---
name: SNARK worker bundling
description: Build and lifecycle constraints for worker-spawning zero-knowledge cryptography libraries.
---

Keep libraries that discover worker entrypoints from their own module filenames external to esbuild server and test bundles. Test processes may explicitly terminate their cryptographic worker pools; long-running servers should retain warmed pools.

**Why:** Bundling can rewrite the worker entrypoint to the surrounding test or server bundle, recursively executing tests or startup code. Unconditional teardown also makes every production verification pay cold initialization cost.

**How to apply:** When changing API/test bundling or cryptography dependencies, verify worker-spawning packages remain external and keep teardown conditional on the test environment. Pre-warm with a known valid proof in the background after the server is serving (the user requires heavy warm-up to never delay listening), and import the libraries lazily so they stay off the startup path. Self-verify newly generated proofs before returning them, then cache only that successful verification so their first external check is fast without weakening integrity.

**Groth16 verification runs on one `worker_threads` worker** (user requirement, 2026-10-15), so a cold pass never blocks the server's event loop. The worker script is a plain ESM file that is never bundled. Every build path (the API build, the test build and the npm release) must copy it next to the server bundle, and the npm release check requires it.
- Inside a worker thread, ffjavascript's multi-threaded curve fails with "Worker is not a constructor". Build the single-threaded bn128 curve into the global cache that snarkjs reuses before verifying.
- The `web-worker` package runs its own worker shim whenever it is imported off the main thread, and loads `workerData.mod`. Pass `{ type: "module", mod: "data:text/javascript," }` as workerData so that shim loads an empty module.
- Unref the idle worker so it never keeps the process alive, and terminate it on shutdown.
- Measured locally: cold pass 1.3 s, warm 25–37 ms, worst main-loop delay 14 ms. The old main-thread path took about 100 ms per warm verification and 6–7 s cold on the production VM.