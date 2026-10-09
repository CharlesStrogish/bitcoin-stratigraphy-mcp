"""Private, WAL-backed escrow storage. No credentials are returned by public reads."""

from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
import stat


SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_escrow_contracts (
    escrow_id TEXT PRIMARY KEY,
    buyer_pubkey TEXT NOT NULL,
    worker_pubkey TEXT NOT NULL,
    task_hash TEXT NOT NULL CHECK(length(task_hash) = 64),
    amount_sats INTEGER NOT NULL CHECK(amount_sats > 0),
    toll_fee_sats INTEGER NOT NULL DEFAULT 21 CHECK(toll_fee_sats = 21),
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

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA busy_timeout=5000")
            mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
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
