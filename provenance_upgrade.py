# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Six-hour, non-blocking OTS finalization with independent Bitcoin evidence."""

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from provenance_anchor import MAX_FILE_SIZE, ProofUnavailable, proof_status

UPGRADE_INTERVAL = 6 * 60 * 60
logger = logging.getLogger(__name__)


def finalize_proof(proof: bytes, *, verifier=None) -> bytes | None:
    """Upgrade using official OTS primitives; publish only corroborated Bitcoin paths.

    OTS upgrade alone supplies an attestation, not a verified mined block. The
    shared verifier additionally checks two matching public headers, header hash,
    proof of work and the OTS Merkle root. This is not full-node chain validation.
    """
    # Imported on first use, off the Enterprise Agent API's startup path.
    from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
    from opentimestamps.core.op import OpSHA256
    from opentimestamps.core.serialize import BytesDeserializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile

    from bitcoin_stratigraphy_enterprise.audit_verifier_ots import OtsVerifier, deserialize, serialize

    if not proof or len(proof) > MAX_FILE_SIZE:
        raise ProofUnavailable("Invalid archived proof size")
    context = BytesDeserializationContext(proof)
    original = DetachedTimestampFile.deserialize(context)
    context.assert_eof()
    if not isinstance(original.file_hash_op, OpSHA256):
        raise ProofUnavailable("Only SHA-256 detached receipts are supported")
    if not any(
        isinstance(a, PendingAttestation) for _, a in original.timestamp.all_attestations()
    ):
        return None  # Already calendar-independent; do not rewrite every six hours.
    verifier = verifier if verifier is not None else OtsVerifier(timeout=5, max_calendars=8)
    verdict = verifier.verify(proof, original.file_digest.hex())
    if verdict.status != "verified" or verdict.proof is None:
        return None  # Not mined, unavailable or mismatched: retain original bytes.
    receipt = deserialize(verdict.proof, original.file_digest.hex())

    def retain_verified_paths(node):
        verified = set()
        for attestation in node.attestations:
            if (
                isinstance(attestation, BitcoinBlockHeaderAttestation)
                and attestation.height == verdict.height
            ):
                try:
                    verifier.bitcoin.verify(node.msg, attestation)
                    verified.add(attestation)
                except Exception:
                    continue
        node.attestations = verified
        for operation, child in list(node.ops.items()):
            if not retain_verified_paths(child):
                del node.ops[operation]
        return bool(node.attestations or node.ops)

    # Prune pending attestations AND their now-empty branches. An empty leaf
    # cannot be serialized in OTS; simply deleting pending attestations is unsafe.
    if not retain_verified_paths(receipt.timestamp):
        return None
    return serialize(receipt)


class ProvenanceUpgrader:
    """Single sequential worker, separate from asyncio and the pipeline executor."""

    def __init__(self, storage, *, interval=UPGRADE_INTERVAL, start_delay=0.0):
        if interval <= 0:
            raise ValueError("Upgrade interval must be positive")
        if start_delay < 0:
            raise ValueError("Upgrade start delay must not be negative")
        self.storage, self.interval, self.start_delay = storage, interval, start_delay
        self._task = None
        self._executor = None
        self._stopped = threading.Event()

    async def start(self):
        if self._task is None:
            self._stopped.clear()
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ots-upgrade")
            self._task = asyncio.create_task(self._run(), name="bitcoin-provenance-upgrade")

    async def stop(self):
        self._stopped.set()
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self._executor is not None:
            # In-flight bounded HTTP reads may finish, but cannot publish after stop.
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    def upgrade_all(self):
        for key in self.storage.proof_keys():
            if self._stopped.is_set():
                return
            try:
                current = self.storage.read_proof_version(key)
                if current is None:
                    continue
                proof, generation = current
                # Daily proofs must still bind the exact immutable cloud JSON.
                if key.startswith(self.storage.prefix + "snapshot_") and key.endswith(".json.ots"):
                    day = key[len(self.storage.prefix + "snapshot_"):-len(".json.ots")]
                    snapshot = self.storage.get(day)
                    if snapshot is None:
                        continue
                    proof_status(snapshot, proof)
                finalized = finalize_proof(proof)
                if finalized is not None and not self._stopped.is_set():
                    self.storage.replace_proof(key, finalized, generation)
            except Exception as exc:
                # No proof bytes, URLs or credential-bearing exception messages.
                logger.debug("OTS upgrade deferred (%s)", type(exc).__name__)
            # Yield the dedicated thread between objects; never busy-loop retries.
            if self._stopped.wait(0.01):
                return

    async def _run(self):
        loop = asyncio.get_running_loop()
        if self.start_delay:
            # Let a freshly booted server settle before the first calendar pass.
            await asyncio.sleep(self.start_delay)
        due = loop.time()
        while True:
            try:
                await loop.run_in_executor(self._executor, self.upgrade_all)
            except Exception as exc:
                logger.debug("OTS upgrade scan deferred (%s)", type(exc).__name__)
            due += self.interval
            if due <= loop.time():
                due = loop.time() + self.interval
            await asyncio.sleep(max(0, due - loop.time()))
