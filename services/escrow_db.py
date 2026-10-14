# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Private, WAL-backed escrow storage. No credentials are returned by public reads."""

from contextlib import contextmanager
import os
from pathlib import Path
import re
import sqlite3
import stat
import time


SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_escrow_contracts (
    escrow_id TEXT PRIMARY KEY,
    buyer_pubkey TEXT NOT NULL,
    worker_pubkey TEXT NOT NULL,
    task_hash TEXT NOT NULL CHECK(length(task_hash) = 64),
    amount_sats INTEGER NOT NULL CHECK(amount_sats > 0),
    toll_fee_sats INTEGER NOT NULL DEFAULT 21
        CHECK(typeof(toll_fee_sats) = 'integer' AND toll_fee_sats >= 1),
    payment_hash TEXT NOT NULL CHECK(length(payment_hash) = 64),
    preimage TEXT NOT NULL CHECK(length(preimage) = 64),
    status TEXT NOT NULL CHECK(status IN
        ('PENDING', 'LOCKED', 'SETTLED', 'EXPIRED', 'DISPUTED')),
    execution_leaf_hash TEXT,
    settled_at_strata_block INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS escrow_execution_leaves (
    leaf_index INTEGER PRIMARY KEY,
    escrow_id TEXT NOT NULL UNIQUE REFERENCES agent_escrow_contracts(escrow_id),
    leaf_preimage BLOB NOT NULL CHECK(length(leaf_preimage) = 96),
    receipt_json TEXT NOT NULL
);
"""


# SQLite skips the busy handler when connections race to convert a cold
# rollback-journal database to WAL (deadlock avoidance). Retry only that lock
# contention within the same 5-second window, then fail closed.
WAL_TRANSITION_TIMEOUT_SECONDS = 5.0


def enable_wal(connection, timeout=WAL_TRANSITION_TIMEOUT_SECONDS):
    """Request WAL and return the resulting journal mode."""
    deadline = time.monotonic() + timeout
    delay = 0.01
    while True:
        try:
            return connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() or time.monotonic() >= deadline:
                raise
        time.sleep(delay)
        delay = min(delay * 2, 0.2)


class EscrowStore:
    """Each operation owns its connection; SQLite serializes cross-process writes.

    The parent directory must be private because WAL/SHM files also hold secrets.
    Storage is plaintext at rest: use an encrypted, isolated custody volume.
    """

    def __init__(self, path=".data/escrow/escrow.sqlite3"):
        self.path = Path(path).absolute()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        parent = self.path.parent.stat()
        if parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) & 0o077:
            raise PermissionError("Escrow storage directory must be owner-only")
        flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
        descriptor = os.open(self.path, flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077
                or info.st_nlink != 1
            ):
                raise PermissionError("Escrow database must be a private regular file")
        finally:
            os.close(descriptor)
        with self.connection() as connection:
            connection.executescript(SCHEMA)
            self._upgrade_fixed_toll_constraint(connection)

    @staticmethod
    def _upgrade_fixed_toll_constraint(connection):
        """Atomically relax only the legacy toll check; preserve rows and FKs.

        SQLite cannot ALTER a CHECK constraint. Rebuild the same table using its
        original schema, retaining all columns, indexes, triggers and custody data.
        BEGIN IMMEDIATE serializes concurrent worker startups.
        """
        fixed = re.compile(r"CHECK\s*\(\s*toll_fee_sats\s*=\s*21\s*\)", re.I)

        def table_sql():
            return connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' "
                "AND name='agent_escrow_contracts'"
            ).fetchone()[0]

        if not fixed.search(table_sql()):
            return
        connection.execute("PRAGMA foreign_keys=OFF")
        try:
            connection.execute("BEGIN IMMEDIATE")
            original = table_sql()
            if fixed.search(original):
                objects = connection.execute(
                    "SELECT sql FROM sqlite_master WHERE tbl_name='agent_escrow_contracts' "
                    "AND type IN ('index', 'trigger') AND sql IS NOT NULL"
                ).fetchall()
                revised = fixed.sub(
                    "CHECK(typeof(toll_fee_sats) = 'integer' AND toll_fee_sats >= 1)",
                    original,
                ).replace("agent_escrow_contracts", "agent_escrow_contracts_dynamic", 1)
                connection.execute(revised)
                connection.execute(
                    "INSERT INTO agent_escrow_contracts_dynamic "
                    "SELECT * FROM agent_escrow_contracts"
                )
                connection.execute("DROP TABLE agent_escrow_contracts")
                connection.execute(
                    "ALTER TABLE agent_escrow_contracts_dynamic RENAME TO agent_escrow_contracts"
                )
                for row in objects:
                    connection.execute(row[0])
                if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise RuntimeError("Escrow constraint migration failed integrity check")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.execute("PRAGMA foreign_keys=ON")

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA busy_timeout=5000")
            mode = enable_wal(connection)
            if mode.lower() != "wal":
                raise RuntimeError("Escrow database requires WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute("PRAGMA foreign_keys=ON")
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self):
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def get_contract(self, escrow_id):
        """Read metadata only; the preimage never leaves storage through this API."""
        with self.connection() as connection:
            row = connection.execute(
                """SELECT escrow_id, buyer_pubkey, worker_pubkey, task_hash,
                   amount_sats, toll_fee_sats, payment_hash, status,
                   execution_leaf_hash, settled_at_strata_block, created_at
                   FROM agent_escrow_contracts WHERE escrow_id = ?""",
                (escrow_id,),
            ).fetchone()
            return dict(row) if row is not None else None
