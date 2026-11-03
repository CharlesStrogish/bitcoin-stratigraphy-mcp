"""Private, durable, cross-process invoice reservations; unknown stays reserved."""

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .errors import FiduciaryError


class PaymentState:
    def __init__(self, directory: str, endpoint: str):
        folder = Path(directory).expanduser()
        folder.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.path = folder / "payments.sqlite3"
        # Create with restrictive permissions before sqlite opens the file.
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.path, 0o600)
        with self.transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS metadata (endpoint TEXT NOT NULL)")
            prior = db.execute("SELECT endpoint FROM metadata").fetchone()
            if prior and prior[0] != endpoint:
                raise FiduciaryError("STATE_ENDPOINT_MISMATCH")
            if not prior:
                db.execute("INSERT INTO metadata VALUES (?)", (endpoint,))
            db.execute("""CREATE TABLE IF NOT EXISTS invoices (
                hash TEXT PRIMARY KEY, binding TEXT NOT NULL, invoice TEXT NOT NULL,
                macaroon TEXT NOT NULL, amount INTEGER NOT NULL, reserved INTEGER NOT NULL,
                status TEXT NOT NULL, preimage TEXT, claim_status TEXT, claim_body TEXT
            )""")
            db.execute("CREATE TABLE IF NOT EXISTS policy (blocked INTEGER NOT NULL)")
            if not db.execute("SELECT 1 FROM policy").fetchone():
                db.execute("INSERT INTO policy VALUES (0)")

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA busy_timeout = 15000")
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def reserve(
        self, payment_hash, binding, invoice, macaroon, amount, fee, limit, total
    ):
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM invoices WHERE hash=?", (payment_hash,)
            ).fetchone()
            if row:
                if (row["binding"], row["invoice"], row["macaroon"]) != (
                    binding,
                    invoice,
                    macaroon,
                ):
                    raise FiduciaryError("PAYMENT_SCOPE_MISMATCH")
                if row["status"] != "paid":
                    raise FiduciaryError("PAYMENT_PENDING_DO_NOT_REPAY")
                return dict(row)
            used = db.execute(
                "SELECT COALESCE(SUM(reserved),0) FROM invoices"
            ).fetchone()[0]
            if (
                db.execute("SELECT blocked FROM policy").fetchone()[0]
                or amount > limit
                or used + amount + fee > total
            ):
                raise FiduciaryError("SPENDING_LIMIT_EXCEEDED")
            db.execute(
                "INSERT INTO invoices VALUES (?,?,?,?,?,?,'pending',NULL,NULL,NULL)",
                (payment_hash, binding, invoice, macaroon, amount, amount + fee),
            )
            return None

    def paid(self, payment_hash, preimage, fees, fee_reserve):
        with self.transaction() as db:
            changed = db.execute(
                "UPDATE invoices SET status='paid',preimage=? WHERE hash=? AND status='pending'",
                (preimage, payment_hash),
            ).rowcount
            if changed != 1:
                raise FiduciaryError("PAYMENT_STATE_CONFLICT")
            if fees is not None and (
                type(fees) is not int or not 0 <= fees <= fee_reserve
            ):
                db.execute("UPDATE policy SET blocked=1")

    def begin_claim(self, payment_hash):
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM invoices WHERE hash=?", (payment_hash,)
            ).fetchone()
            if not row or row["status"] != "paid" or row["claim_status"]:
                return None
            db.execute(
                "UPDATE invoices SET claim_status='preparing' WHERE hash=?",
                (payment_hash,),
            )
            return dict(row)

    def prepare_claim(self, payment_hash, body):
        with self.transaction() as db:
            db.execute(
                "UPDATE invoices SET claim_status='prepared',claim_body=? WHERE hash=?",
                (json.dumps(body, separators=(",", ":")), payment_hash),
            )

    def finish_claim(self, payment_hash, status):
        with self.transaction() as db:
            row = db.execute(
                "SELECT claim_status FROM invoices WHERE hash=?", (payment_hash,)
            ).fetchone()
            # A late pending/error response must never undo a settled claim.
            if row and row[0] != "settled":
                db.execute(
                    "UPDATE invoices SET claim_status=? WHERE hash=?",
                    (status, payment_hash),
                )
                return True
            return False

    def claim(self, payment_hash):
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM invoices WHERE hash=?", (payment_hash,)
            ).fetchone()
            if not row or not row["claim_body"]:
                raise FiduciaryError("NO_PREPARED_CLAIM_OPERATOR_RECOVERY_REQUIRED")
            return dict(row)
