#!/usr/bin/env python3
"""Bilateral enterprise contract-state settlement, not escrow or corporate KYC.

Sandbox: stratigraphy-b2b
Production (explicitly consumes a prepaid notary call):
    stratigraphy-b2b --production
Supply a proof.notarize-scoped L402_AUTHORIZATION via your secret manager.
No wallet is invoked, invoice purchased or payment retried by this cookbook.
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import stat
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit
from uuid import uuid4

from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from .article_12_journal import canonical_json, sha256
from .audit_verifier import strict_json
from .b2b_contract import (
    CONTRACT_SCHEMA, PACKAGE_SCHEMA, RECEIPT_SCHEMA, ROLES, ContractVerificationError,
    SigningAgent, exact_fields, signed_package, snapshot, utc, validate_contract,
)
from .b2b_settlement_verifier import checked_ots, verify_contract_settlement
from .client import BitcoinStratigraphyClient, DEFAULT_MCP_SERVER_URL


class ContractNotarizer(Protocol):
    def notarize(self, digest: str) -> dict: ...


class PrepaidMacroNotarizer:
    """One tool call using a supplied, prepaid 100-call Macro-Macaroon.

    The batch header does not manufacture a prepaid pass or pay an invoice.
    A rejected/exhausted/expired pass fails; no wallet callback is attached.
    """
    def __init__(self, authorization: str, url=DEFAULT_MCP_SERVER_URL, timeout=10):
        parsed = urlsplit(url)
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
                or (parsed.scheme != "https" and not
                    (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}))):
            raise ValueError("Use credential-free HTTPS or loopback HTTP")
        if type(authorization) is not str or not re.fullmatch(
                r"L402 [A-Za-z0-9_+/=-]{1,8192}:[0-9a-fA-F]{64}", authorization):
            raise ValueError("A valid prepaid L402 authorization is required")
        self._client = BitcoinStratigraphyClient(url, timeout=timeout, headers={
            "Authorization": authorization, "X-L402-Batch-Size": "100",
        })

    def notarize(self, digest):
        return self._client.call_tool("proof.notarize", {"hash": digest})


class B2BSettlementProtocol:
    """Modular two-party signing, notary submission, and mutually sealed receipt.

    Agents may be adapters to separate corporate key custodians. Each approval
    receives detached terms. Local replay protection is process-local: production
    needs durable transaction IDs, trusted enterprise key enrollment, and
    authenticated proposal transport. Never automatically retry uncertain fees.
    """
    def __init__(self, notarizer: ContractNotarizer | None = None, *, now=None):
        self.notarizer = notarizer
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()
        self._receipts = {}
        self._nonces = {}
        self._reserved_ids = {}

    def agree(self, contract_payload, client: SigningAgent, vendor: SigningAgent):
        payload = snapshot(contract_payload)
        validate_contract(payload)
        self._ensure_unexpired(payload)
        agents = self._agents(payload, client, vendor)
        signatures = {role: agents[role].sign_contract(snapshot(payload)) for role in ROLES}
        return signed_package(payload, signatures)

    @staticmethod
    def _agents(payload, client, vendor):
        agents = {"client": client, "vendor": vendor}
        for role, agent in agents.items():
            if (agent.role != role or payload["parties"][role] !=
                    {"agent_id": agent.agent_id, "public_key": agent.public_key}):
                raise ContractVerificationError("Agent identity/role does not match agreed parties")
        return agents

    def _ensure_unexpired(self, payload):
        now = self._now()
        if now.tzinfo is None or now >= utc(payload["expiration_utc"]):
            raise ContractVerificationError("Cannot initiate settlement for an expired contract")
        if now < utc(payload["issued_utc"]):
            raise ContractVerificationError("Claimed contract issuance is in the future")

    def settle(self, agreement, client: SigningAgent, vendor: SigningAgent):
        agreement = snapshot(agreement)
        exact_fields(agreement, {"schema_version", "contract", "signatures"})
        if agreement["schema_version"] != PACKAGE_SCHEMA:
            raise ContractVerificationError("Unsupported signed-package schema")
        package = signed_package(agreement["contract"], agreement["signatures"])
        payload = package["contract"]
        agents = self._agents(payload, client, vendor)
        digest = sha256(package)
        key = payload["contract_id"]
        with self._lock:
            prior = self._receipts.get(key)
            if prior:
                if prior["body"]["contract_hash"] != digest:
                    raise ContractVerificationError("Contract ID already used for different terms")
                return snapshot(prior)
            if key in self._reserved_ids:
                raise ContractVerificationError("Contract ID already reserved; resolve uncertain settlement manually")
            if payload["nonce"] in self._nonces:
                raise ContractVerificationError("Nonce already used or reserved; do not retry uncertain settlement")
            if len(self._nonces) >= 1000:
                raise ContractVerificationError("Local session capacity reached; use durable production coordination")
            self._ensure_unexpired(payload)  # Immediately before any paid operation.
            # Reserve BEFORE submission. Even a failed seal or ambiguous request
            # must never trigger an implicit second prepaid-quota redemption.
            self._nonces[payload["nonce"]] = key
            self._reserved_ids[key] = digest
            anchor = {"status": "deferred", "hash": digest, "otsProofHex": None, "settlement_unknown": False}
            if self.notarizer is not None:
                try:
                    result = self.notarizer.notarize(digest)
                    if (type(result) is not dict or result.get("hash") != digest
                            or result.get("otsStatus") != "pending_calendar"):
                        raise ContractVerificationError("Notary returned conflicting receipt metadata")
                    ots = checked_ots(result.get("otsProofHex"), digest)
                    if not any(isinstance(a, (PendingAttestation, BitcoinBlockHeaderAttestation))
                               for _, a in ots.timestamp.all_attestations()):
                        raise ContractVerificationError("Notary returned no calendar or Bitcoin attestation")
                    anchor.update(status="pending_calendar", otsProofHex=result["otsProofHex"])
                except Exception:
                    anchor.update(status="unavailable", settlement_unknown=True)
            body = {
                "schema_version": RECEIPT_SCHEMA, "contract_id": key, "nonce": payload["nonce"],
                "parties": snapshot(payload["parties"]), "contract_hash": digest,
                "contract_signatures": snapshot(package["signatures"]),
                "expiration_utc": payload["expiration_utc"],
                "generated_utc": self._now().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "anchoring": anchor,
            }
            seals = {role: agents[role].sign_receipt(snapshot(body), snapshot(package)) for role in ROLES}
            receipt = {"body": body, "receipt_signatures": seals}
            verify_contract_settlement(receipt, payload)
            self._receipts[key] = snapshot(receipt)
            return snapshot(receipt)

    def negotiate(self, contract_payload, client: SigningAgent, vendor: SigningAgent):
        agreement = self.agree(contract_payload, client, vendor)
        return self.settle(agreement, client, vendor)


def demo_contract(client, vendor, now=None):
    now = (now or datetime.now(timezone.utc)).replace(microsecond=0)
    return {
        "schema_version": CONTRACT_SCHEMA, "contract_id": str(uuid4()),
        "parties": {agent.role: {"agent_id": agent.agent_id, "public_key": agent.public_key}
                    for agent in (client, vendor)},
        "scope": {"description": "Monthly enterprise analytics procurement",
                  "deliverables": ["Daily machine-readable analytics report", "Monthly integrity evidence archive"]},
        "sla": {"max_latency_ms": 1500, "availability_basis_points": 9950},
        "pricing": {"currency": "USD", "amount_minor": 180000, "payment_due_days": 30},
        "terms": ["Contract-state anchoring does not transfer the procurement amount.",
                  "Authorized auditors may independently verify exact agreed terms and evidence."],
        "issued_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expiration_utc": (now + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "nonce": secrets.token_hex(32),
    }


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Expected a regular JSON evidence file")
        data = stream.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("Evidence exceeds 2 MiB")
    return strict_json(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--production", action="store_true", help="Synthetic demo using one real prepaid notary call")
    parser.add_argument("--url", default=DEFAULT_MCP_SERVER_URL)
    parser.add_argument("--verify", type=Path, help="Read an original sealed receipt (offline)")
    parser.add_argument("--contract", type=Path, help="Read exact original contract terms")
    parser.add_argument("--trusted-headers", type=Path, help="Separately trusted mainnet height-to-header JSON map")
    parser.add_argument("--party-keys", type=Path, help="Independently pinned client/vendor public-key JSON map")
    parser.add_argument("--upgraded-ots", type=Path, help="Read auditor-upgraded binary OTS evidence (offline)")
    args = parser.parse_args(argv)
    if args.production and args.verify:
        parser.error("Offline verification cannot run in production mode")
    if not args.verify and any((args.contract, args.trusted_headers, args.upgraded_ots, args.party_keys)):
        parser.error("Evidence-file options require --verify; --production is a synthetic demonstration")
    try:
        if args.verify:
            if not args.contract:
                parser.error("--verify requires --contract")
            proof = None
            if args.upgraded_ots:
                with args.upgraded_ots.open("rb") as stream:
                    proof = stream.read(512 * 1024 + 1).hex()
            report = verify_contract_settlement(
                read_json(args.verify), read_json(args.contract),
                trusted_headers=read_json(args.trusted_headers) if args.trusted_headers else None,
                upgraded_ots_proof_hex=proof,
                expected_party_keys=read_json(args.party_keys) if args.party_keys else None,
            )
            print(canonical_json(report).decode("utf-8"))
            return 0 if report["status"] == "verified_header_time" else 2
        client = SigningAgent.generate("AcmeClientSwarm", "client",
                                      approve=lambda p: p["pricing"]["amount_minor"] <= 160000)
        vendor = SigningAgent.generate("MeridianVendorSwarm", "vendor",
                                      approve=lambda p: p["pricing"]["amount_minor"] >= 140000)
        proposal = demo_contract(client, vendor)
        print("VendorAgent proposes USD 1800.00; ClientAgent counters USD 1500.00; VendorAgent accepts.")
        proposal["pricing"]["amount_minor"] = 150000
        authorization = os.environ.get("L402_AUTHORIZATION") if args.production else None
        notary = PrepaidMacroNotarizer(authorization, args.url) if authorization else None
        if notary is not None:
            print("Production demo: synthetic terms; one REAL prepaid proof.notarize call will be consumed.")
        receipt = B2BSettlementProtocol(notary).negotiate(proposal, client, vendor)
        print("Ephemeral demo keys; corporate identities are claims. No contract funds are transferred.")
        print("Canonical contract:", canonical_json(proposal).decode("utf-8"))
        print("Both contract signatures:", canonical_json(receipt["body"]["contract_signatures"]).decode("utf-8"))
        print("Settlement receipt:", canonical_json(receipt).decode("utf-8"))
        report = verify_contract_settlement(receipt, proposal)
        print(report["detail"])
        return 2 if report["status"] == "unavailable" else 0
    except Exception as error:
        # Never echo wallet credentials, raw terms, or provider exception text.
        print(f"Contract settlement failed: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
