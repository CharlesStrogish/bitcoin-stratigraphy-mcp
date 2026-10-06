# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Durable append-only, hash-chained JSONL storage for Article 12 evidence.

POSIX flock coordinates cooperating processes. This is not WORM storage:
an administrator can still rewrite the file. Anchor/checkpoint and archive it
under your organization's retention and access-control policies.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:
    fcntl = None


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


def canonical_json(value: Any) -> bytes:
    """Project-defined canonical JSON: sorted keys, compact UTF-8, no NaN."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


class AuditJournal:
    """Fsync every record; refuse unsafe files and corrupted/partial journals."""

    def __init__(self, path: str | Path = "audit_trail.jsonl"):
        if fcntl is None:
            raise OSError("This audit journal requires POSIX flock")
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    @contextmanager
    def _locked(self):
        fd = os.open(
            self.path,
            os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        try:
            info = os.fstat(fd)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_uid != os.geteuid()
                or info.st_mode & 0o077
            ):
                raise PermissionError(
                    "Audit file must be owner-only, singly linked, and owned by the process user"
                )
            fcntl.flock(fd, fcntl.LOCK_EX)
            with os.fdopen(os.dup(fd), "r", encoding="utf-8") as stream:
                stream.seek(0)
                records = []
                previous = "0" * 64
                for sequence, line in enumerate(stream, 1):
                    if not line.endswith("\n"):
                        raise ValueError(
                            "Incomplete audit record; operator recovery required"
                        )
                    record = json.loads(line)
                    claimed = record["record_hash"]
                    body = {k: v for k, v in record.items() if k != "record_hash"}
                    if (
                        body["sequence"] != sequence
                        or body["previous_record_hash"] != previous
                        or sha256(body) != claimed
                    ):
                        raise ValueError("Audit journal integrity check failed")
                    if (
                        body["kind"] == "trace"
                        and sha256(body["trace"]) != body["trace_hash"]
                    ):
                        raise ValueError("Stored execution trace digest does not match")
                    records.append(record)
                    previous = claimed
            yield fd, records
        finally:
            os.close(fd)

    @staticmethod
    def _write(fd: int, records: list[dict], record: dict) -> dict:
        body = {
            **record,
            "sequence": len(records) + 1,
            "previous_record_hash": records[-1]["record_hash"] if records else "0" * 64,
        }
        result = {**body, "record_hash": sha256(body)}
        data = canonical_json(result) + b"\n"
        while data:
            count = os.write(fd, data)
            if count <= 0:
                raise OSError("Could not append audit record")
            data = data[count:]
        os.fsync(fd)
        # Persist creation of the filename as well as its contents.
        return result

    def append(self, record: dict) -> dict:
        with self._locked() as (fd, records):
            result = self._write(fd, records, record)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return result

    def records(self) -> list[dict]:
        with self._locked() as (_, records):
            return records

    def claim(
        self,
        trace_id: str,
        digest: str,
        *,
        retry_uncertain: bool = False,
        lease_seconds: float = 120,
    ) -> bool:
        """Atomically reserve one attempt, preventing duplicate cooperative replay."""
        with self._locked() as (fd, records):
            history = [r for r in records if r["trace_id"] == trace_id]
            if not history or history[0]["trace_hash"] != digest:
                raise ValueError("Missing or mismatched durable trace")
            latest = history[-1]
            if latest.get("status") == "notarized":
                return False
            if latest.get("status") == "attempting":
                elapsed = (
                    datetime.now(timezone.utc)
                    - datetime.fromisoformat(
                        latest["timestamp_utc"].replace("Z", "+00:00")
                    )
                ).total_seconds()
                if not retry_uncertain or elapsed < latest["lease_seconds"]:
                    return False
            if latest.get("settlement_unknown") and not retry_uncertain:
                return False
            self._write(
                fd,
                records,
                {
                    "kind": "status",
                    "trace_id": trace_id,
                    "trace_hash": digest,
                    "timestamp_utc": utc_now(),
                    "status": "attempting",
                    "lease_seconds": lease_seconds,
                    "settlement_unknown": True,
                },
            )
            return True

    def pending(self, *, retry_uncertain: bool = False) -> list[dict]:
        traces, latest = {}, {}
        for record in self.records():
            latest[record["trace_id"]] = record
            if record["kind"] == "trace":
                traces[record["trace_id"]] = record
        return [
            trace
            for key, trace in traces.items()
            if latest[key].get("status") != "notarized"
            and (retry_uncertain or not latest[key].get("settlement_unknown"))
        ]
