# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Daily archives in App Storage; snapshots immutable, proofs safely upgradeable."""

import functools
import os
import re
import threading
from types import SimpleNamespace

from provenance_anchor import MAX_FILE_SIZE, ProofNotFound, ProofUnavailable, proof_status, validate_date
from stratigraphy_pipeline import StratigraphyMetrics

OBJECT_PREFIX = "provenance/daily/"


class StorageUnavailable(Exception):
    """Storage failed; never interpret an outage as an absent archive."""


@functools.cache
def _sdk():
    """Import the App Storage SDK and its Google Cloud client on first use.

    They add about 300 modules, so they stay off the Enterprise Agent API's
    startup path.
    """
    try:
        from google.api_core.exceptions import NotFound, PreconditionFailed
        from google.api_core.retry import Retry
        from replit.object_storage import Client
    except ImportError as exc:
        raise StorageUnavailable("App Storage SDK unavailable") from exc
    return SimpleNamespace(
        Client=Client, NotFound=NotFound, PreconditionFailed=PreconditionFailed, retry=Retry(deadline=15),
    )


def validate_snapshot(body: bytes):
    if not body or len(body) > MAX_FILE_SIZE:
        raise ProofUnavailable("Invalid archived snapshot size")
    try:
        StratigraphyMetrics.model_validate_json(body)
    except ValueError as exc:
        raise ProofUnavailable("Invalid archived stratigraphy snapshot") from exc


class ObjectArchive:
    def __init__(self, *, prefix=OBJECT_PREFIX):
        self.prefix = prefix
        self._threads = threading.local()

    def _bucket(self):
        # Separate SDK transports per thread; all resolve the same configured bucket.
        if not hasattr(self._threads, "client"):
            bucket_id = os.environ.get("DEFAULT_OBJECT_STORAGE_BUCKET_ID")
            if not bucket_id:
                raise StorageUnavailable("App Storage bucket is not configured")
            self._threads.client = _sdk().Client(bucket_id=bucket_id)
        # SDK 1.0.2 does not expose create-only uploads, range reads or timeouts.
        # Use its authenticated GCS handle for those safety-critical operations.
        return self._threads.client._Client__bucket()

    def key(self, day: str, *, proof=False):
        return self.prefix + f"snapshot_{validate_date(day)}.json" + (".ots" if proof else "")

    def get(self, day: str, *, proof=False) -> bytes | None:
        key = self.key(day, proof=proof)
        sdk = _sdk()
        try:
            # Inclusive range permits detecting objects larger than our limit.
            body = self._bucket().blob(key).download_as_bytes(
                start=0, end=MAX_FILE_SIZE, timeout=10, retry=sdk.retry,
            )
        except sdk.NotFound:
            return None
        except Exception as exc:
            raise StorageUnavailable("App Storage download unavailable") from exc
        if not body or len(body) > MAX_FILE_SIZE:
            raise ProofUnavailable("Invalid archived object size")
        return body

    def put(self, day: str, body: bytes, *, proof=False) -> bytes:
        if not body or len(body) > MAX_FILE_SIZE:
            raise ProofUnavailable("Invalid archived object size")
        key = self.key(day, proof=proof)
        sdk = _sdk()
        try:
            self._bucket().blob(key).upload_from_string(
                body, content_type="application/octet-stream" if proof else "application/json",
                if_generation_match=0, timeout=10, retry=sdk.retry,
            )
            return body
        except sdk.PreconditionFailed:
            # A competing instance (or an acknowledged-late retry) already won.
            winner = self.get(day, proof=proof)
            if winner is None:
                raise StorageUnavailable("Existing archive disappeared")
            return winner
        except Exception as exc:
            raise StorageUnavailable("App Storage upload unavailable") from exc

    def days(self) -> tuple[set[str], set[str]]:
        snapshots, proofs = set(), set()
        sdk = _sdk()
        try:
            for item in self._bucket().list_blobs(prefix=self.prefix, timeout=10, retry=sdk.retry):
                match = re.fullmatch(
                    re.escape(self.prefix) + r"snapshot_(\d{4}-\d{2}-\d{2})\.json(\.ots)?", item.name,
                )
                if match:
                    try:
                        day = validate_date(match[1])
                    except ValueError:
                        continue
                    (proofs if match[2] else snapshots).add(day)
        except Exception as exc:
            raise StorageUnavailable("App Storage archive listing unavailable") from exc
        return snapshots, proofs

    def proof_keys(self):
        """Stream every .ots object in the configured bucket, not only daily files."""
        sdk = _sdk()
        try:
            for item in self._bucket().list_blobs(timeout=10, retry=sdk.retry):
                if item.name.endswith(".ots"):
                    yield item.name
        except Exception as exc:
            raise StorageUnavailable("App Storage proof listing unavailable") from exc

    def read_proof_version(self, key: str) -> tuple[bytes, int] | None:
        """Read exact bytes at one generation for a later compare-and-swap."""
        if not key.endswith(".ots"):
            raise ValueError("Expected an OTS object")
        sdk = _sdk()
        try:
            blob = self._bucket().blob(key)
            blob.reload(timeout=10, retry=sdk.retry)
            generation = int(blob.generation)
            body = blob.download_as_bytes(
                start=0, end=MAX_FILE_SIZE, if_generation_match=generation,
                timeout=10, retry=sdk.retry,
            )
        except (sdk.NotFound, sdk.PreconditionFailed):
            return None  # Deleted/changed during discovery; retry next pass.
        except Exception as exc:
            raise StorageUnavailable("App Storage versioned proof read unavailable") from exc
        if not body or len(body) > MAX_FILE_SIZE:
            raise ProofUnavailable("Invalid archived proof size")
        return body, generation

    def replace_proof(self, key: str, body: bytes, generation: int) -> bool:
        """Atomically replace only the proof generation we actually verified."""
        if not key.endswith(".ots") or generation <= 0:
            raise ValueError("Expected an existing OTS object generation")
        if not body or len(body) > MAX_FILE_SIZE:
            raise ProofUnavailable("Invalid upgraded proof size")
        sdk = _sdk()
        try:
            self._bucket().blob(key).upload_from_string(
                body, content_type="application/octet-stream",
                if_generation_match=generation, timeout=10, retry=sdk.retry,
            )
            return True
        except (sdk.NotFound, sdk.PreconditionFailed):
            return False  # Another process won; never overwrite its newer proof.
        except Exception as exc:
            raise StorageUnavailable("App Storage proof replacement unavailable") from exc

    def load(self, day: str) -> tuple[bytes, bytes, str]:
        snapshot = self.get(day)
        if snapshot is None:
            raise ProofNotFound("No archived snapshot for this UTC date")
        validate_snapshot(snapshot)
        proof = self.get(day, proof=True)
        if proof is None:
            raise ProofUnavailable("Snapshot saved; calendar stamping has not completed")
        return snapshot, proof, proof_status(snapshot, proof)
