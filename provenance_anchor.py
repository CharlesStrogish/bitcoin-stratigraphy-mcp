# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""UTC daily snapshots and standard detached OpenTimestamps receipts."""

import asyncio
import fcntl
import hashlib
import io
import json
import logging
import os
import re
import stat
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

from stratigraphy_pipeline import StratigraphyMetrics

# The OpenTimestamps library (with python-bitcoinlib, pycryptodomex and cffi)
# is imported by the functions that use it, so that it does not delay the
# Enterprise Agent API becoming ready on a cold start.

ARCHIVE_DIRECTORY = Path(__file__).resolve().parent / "generated-artifacts" / "provenance"
MAX_FILE_SIZE = 512 * 1024
logger = logging.getLogger(__name__)


class ProofNotFound(Exception):
    pass


class ProofUnavailable(Exception):
    pass


class MissingHistoricalCapture(ProofUnavailable):
    pass


def validate_date(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Use a date in YYYY-MM-DD format")
    return date.fromisoformat(value).isoformat()


def next_midnight_utc(now: datetime) -> datetime:
    now = now.astimezone(timezone.utc)
    return datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), timezone.utc)


def read_archive_file(path: Path) -> bytes:
    """Read bounded regular files, never symlinks or unbounded local artifacts."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ProofUnavailable("Archive file is not a regular file")
            body = handle.read(MAX_FILE_SIZE + 1)
        if not body or len(body) > MAX_FILE_SIZE:
            raise ProofUnavailable("Invalid archive file size")
        return body
    except FileNotFoundError as exc:
        raise ProofNotFound("No archived snapshot for this UTC date") from exc
    except OSError as exc:
        raise ProofUnavailable("Archive file unavailable") from exc


def proof_status(snapshot: bytes, proof: bytes) -> str:
    from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
    from opentimestamps.core.op import OpSHA256
    from opentimestamps.core.serialize import BytesDeserializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile

    try:
        context = BytesDeserializationContext(proof)
        detached = DetachedTimestampFile.deserialize(context)
        context.assert_eof()
        if not isinstance(detached.file_hash_op, OpSHA256):
            raise ValueError("Expected SHA-256")
        if detached.file_digest != hashlib.sha256(snapshot).digest():
            raise ValueError("Receipt does not bind the exact snapshot bytes")
        attestations = [attestation for _, attestation in detached.timestamp.all_attestations()]
        if any(isinstance(item, BitcoinBlockHeaderAttestation) for item in attestations):
            # Presence is NOT independent Bitcoin verification.
            return "bitcoin_attestation_present_unverified"
        if any(isinstance(item, PendingAttestation) for item in attestations):
            return "pending_bitcoin_confirmation"
        raise ValueError("No calendar or Bitcoin attestation")
    except Exception as exc:
        raise ProofUnavailable("Historical proof failed integrity validation") from exc


def load_historical_proof(directory: Path, day: str) -> tuple[bytes, bytes, str]:
    day = validate_date(day)
    snapshot_path = directory / f"snapshot_{day}.json"
    snapshot = read_archive_file(snapshot_path)
    try:
        proof = read_archive_file(snapshot_path.with_suffix(".json.ots"))
    except ProofNotFound as exc:
        raise ProofUnavailable("Snapshot saved; calendar stamping has not completed") from exc
    try:
        StratigraphyMetrics.model_validate_json(snapshot)
    except ValueError as exc:
        raise ProofUnavailable("Invalid archived stratigraphy snapshot") from exc
    return snapshot, proof, proof_status(snapshot, proof)


async def stamp_snapshot(snapshot: bytes, client: httpx.AsyncClient) -> bytes:
    """Use the official library and CLI-default pools, without blocking asyncio."""
    from opentimestamps.calendar import DEFAULT_AGGREGATORS
    from opentimestamps.core.op import OpAppend, OpSHA256
    from opentimestamps.core.serialize import BytesDeserializationContext, BytesSerializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

    detached = DetachedTimestampFile.from_fd(OpSHA256(), io.BytesIO(snapshot))
    # The standard client blinds file digests before public calendar submission.
    tip = detached.timestamp.ops.add(OpAppend(os.urandom(16))).ops.add(OpSHA256())

    async def submit(root: str):
        async with asyncio.timeout(10):
            async with client.stream(
                "POST", root + "/digest", content=tip.msg,
                headers={
                    "Accept": "application/vnd.opentimestamps.v1",
                    "Content-Type": "application/octet-stream",
                    "User-Agent": "Bitcoin-Stratigraphy-Provenance/1",
                },
                follow_redirects=False,
            ) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > 10_000:
                        raise ProofUnavailable("Calendar receipt exceeds size limit")
                    body.extend(chunk)
        context = BytesDeserializationContext(bytes(body))
        timestamp = Timestamp.deserialize(context, tip.msg)
        context.assert_eof()
        if not list(timestamp.all_attestations()):
            raise ProofUnavailable("Calendar returned no attestations")
        return timestamp

    tasks = [asyncio.create_task(submit(root)) for root in DEFAULT_AGGREGATORS]
    try:
        async with asyncio.timeout(15):
            results = await asyncio.gather(*tasks, return_exceptions=True)
        successes = [result for result in results if isinstance(result, Timestamp)]
        # Same quorum as `ots stamp`'s default -m 2.
        if len(successes) < 2:
            raise ProofUnavailable("Fewer than two default public calendars accepted the stamp")
        for result in successes:
            tip.merge(result)
        context = BytesSerializationContext()
        detached.serialize(context)
        proof = context.getbytes()
        if len(proof) > MAX_FILE_SIZE:
            raise ProofUnavailable("Detached proof exceeds size limit")
        proof_status(snapshot, proof)
        return proof
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@contextmanager
def day_lock(directory: Path, day: str):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(directory / f".{day}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "rb") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def save_once(path: Path, body: bytes):
    """Publish a complete file atomically without replacing an existing archive."""
    temporary = path.with_name(f".{path.name}.{os.urandom(8).hex()}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        # Hard-link publication is atomic and refuses an existing final filename.
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class ProvenanceAnchor:
    """Midnight scheduler; retries preserve saved bytes rather than recapturing."""

    def __init__(
        self, pipeline, client: httpx.AsyncClient, *, directory=ARCHIVE_DIRECTORY, storage=None, start_delay=0.0,
    ):
        from provenance_storage import ObjectArchive

        if start_delay < 0:
            raise ValueError("Anchor start delay must not be negative")
        self.pipeline = pipeline
        self.client = client
        self.directory = Path(directory)
        self.storage = storage if storage is not None else ObjectArchive()
        self.start_delay = start_delay
        self._task: asyncio.Task | None = None

    async def start(self):
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="bitcoin-provenance-anchor")

    async def stop(self):
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def anchor_date(self, day: str):
        day = validate_date(day)
        with day_lock(self.directory, day) as locked:
            if not locked:
                raise ProofUnavailable("Another worker is anchoring this date")
            snapshot_path = self.directory / f"snapshot_{day}.json"
            proof_path = snapshot_path.with_suffix(".json.ots")
            snapshot = await asyncio.to_thread(self.storage.get, day)
            if snapshot is None:
                if snapshot_path.exists():
                    snapshot = read_archive_file(snapshot_path)
                    StratigraphyMetrics.model_validate_json(snapshot)
                else:
                    # Never fabricate a snapshot for a day the process missed.
                    if day != datetime.now(timezone.utc).date().isoformat():
                        raise MissingHistoricalCapture("Cannot backfill a missing historical snapshot")
                    metrics = self.pipeline.get_snapshot()
                    snapshot = (json.dumps(
                        metrics.model_dump(), ensure_ascii=False, allow_nan=False, indent=2
                    ) + "\n").encode("utf-8")
                    if len(snapshot) > MAX_FILE_SIZE:
                        raise ProofUnavailable("Snapshot exceeds size limit")
                    save_once(snapshot_path, snapshot)
                # Upload before contacting calendars. Adopt an existing winner
                # atomically, rather than replacing another instance's snapshot.
                snapshot = await asyncio.to_thread(self.storage.put, day, snapshot)
            StratigraphyMetrics.model_validate_json(snapshot)
            proof = await asyncio.to_thread(self.storage.get, day, proof=True)
            if proof is not None:
                proof_status(snapshot, proof)
                return
            if proof_path.exists():
                proof = read_archive_file(proof_path)
                try:
                    proof_status(snapshot, proof)
                except ProofUnavailable:
                    # This instance's local capture may have lost the cloud race.
                    proof = await stamp_snapshot(snapshot, self.client)
            else:
                proof = await stamp_snapshot(snapshot, self.client)
            proof_status(snapshot, proof)
            if (
                not proof_path.exists() and snapshot_path.exists()
                and read_archive_file(snapshot_path) == snapshot
            ):
                save_once(proof_path, proof)
            # Upload as soon as generated; local files are only a retry cache.
            proof = await asyncio.to_thread(self.storage.put, day, proof, proof=True)
            proof_status(snapshot, proof)
            logger.info("Archived OpenTimestamps snapshot for UTC date %s", day)

    async def _run(self):
        # Resume already-captured, unstamped snapshots after a restart. Never
        # manufacture a missing historical day or stamp a new day at startup.
        pending = set()
        local_days = set()
        if self.directory.exists():
            for path in self.directory.glob("snapshot_????-??-??.json"):
                try:
                    day = validate_date(path.name[9:-5])
                    local_days.add(day)
                except ValueError:
                    continue
        due = next_midnight_utc(datetime.now(timezone.utc))
        # Resume stamping only after a freshly booted server has settled. The
        # midnight schedule is fixed first, so the delay cannot skip a capture.
        retry_at = datetime.now(timezone.utc) + timedelta(seconds=self.start_delay)
        survey_at = retry_at
        while True:
            now = datetime.now(timezone.utc)
            if now >= survey_at:
                try:
                    snapshots, proofs = await asyncio.to_thread(self.storage.days)
                    pending.update((snapshots | local_days) - (snapshots & proofs))
                    local_days.clear()
                except Exception as exc:
                    logger.warning("Provenance archive discovery unavailable (%s)", type(exc).__name__)
                survey_at = datetime.now(timezone.utc) + timedelta(minutes=5)
                now = datetime.now(timezone.utc)
            if now >= due:
                pending.add(due.date().isoformat())
                due = next_midnight_utc(now)
                retry_at = now
            if pending and now >= retry_at:
                for day in sorted(pending):
                    try:
                        await self.anchor_date(day)
                        pending.remove(day)
                    except MissingHistoricalCapture:
                        pending.remove(day)
                        logger.warning("No captured provenance snapshot for missed UTC date %s", day)
                    except Exception as exc:
                        logger.warning("Provenance anchor unavailable for %s (%s)", day, type(exc).__name__)
                retry_at = datetime.now(timezone.utc) + timedelta(minutes=5)
            wake = min(due, retry_at) if pending else due
            delay = (wake - datetime.now(timezone.utc)).total_seconds()
            await asyncio.sleep(max(0.01, min(60, delay)))
