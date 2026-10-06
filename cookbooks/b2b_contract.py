"""Strict deterministic bilateral contract schema and Ed25519 agent signing.

JSON uses the project's sorted-key, compact UTF-8 encoding, not a claim of
RFC 8785 compatibility. Integer monetary/SLA fields avoid float ambiguity.
Keys prove possession, not corporate identity, authority, or enforceability.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from cookbooks.article_12_journal import canonical_json, sha256
from cookbooks.audit_verifier import strict_json

CONTRACT_SCHEMA = "saai-b2b-contract/1"
PACKAGE_SCHEMA = "saai-b2b-signed-package/1"
RECEIPT_SCHEMA = "saai-b2b-settlement/1"
ROLES = ("client", "vendor")


class ContractVerificationError(ValueError):
    """Malformed contract or cryptographic mismatch; never a confirmed settlement."""


def exact_fields(value, fields):
    if type(value) is not dict or set(value) != set(fields):
        raise ContractVerificationError("Unexpected or missing schema fields")


def text(value, limit=4096):
    if type(value) is not str or not value.strip() or len(value.encode("utf-8")) > limit:
        raise ContractVerificationError("Expected bounded nonempty UTF-8 text")


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ContractVerificationError("Integer value outside contract bounds")


def hex_value(value, length):
    if type(value) is not str or not re.fullmatch(rf"[0-9a-f]{{{length}}}", value):
        raise ContractVerificationError("Expected fixed-length lowercase hexadecimal")


def utc(value):
    if type(value) is not str or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise ContractVerificationError("Use canonical UTC YYYY-MM-DDTHH:MM:SSZ")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise ContractVerificationError("Invalid UTC date") from error


def snapshot(value):
    """Detach mutable caller data without changing canonical string contents."""
    return strict_json(canonical_json(value))


def validate_contract(payload):
    exact_fields(payload, {
        "schema_version", "contract_id", "parties", "scope", "sla", "pricing",
        "terms", "issued_utc", "expiration_utc", "nonce",
    })
    if payload["schema_version"] != CONTRACT_SCHEMA:
        raise ContractVerificationError("Unsupported contract schema")
    text(payload["contract_id"], 128)
    hex_value(payload["nonce"], 64)
    if utc(payload["issued_utc"]) >= utc(payload["expiration_utc"]):
        raise ContractVerificationError("Expiration must follow claimed issuance")
    exact_fields(payload["parties"], ROLES)
    for party in payload["parties"].values():
        exact_fields(party, {"agent_id", "public_key"})
        text(party["agent_id"], 128)
        hex_value(party["public_key"], 64)
    client, vendor = (payload["parties"][role] for role in ROLES)
    if client["public_key"] == vendor["public_key"] or client["agent_id"] == vendor["agent_id"]:
        raise ContractVerificationError("Bilateral parties must have distinct keys and agent IDs")
    exact_fields(payload["scope"], {"description", "deliverables"})
    text(payload["scope"]["description"])
    deliverables = payload["scope"]["deliverables"]
    if type(deliverables) is not list or not 1 <= len(deliverables) <= 32:
        raise ContractVerificationError("Expected 1 to 32 deliverables")
    for item in deliverables:
        text(item)
    exact_fields(payload["sla"], {"max_latency_ms", "availability_basis_points"})
    integer(payload["sla"]["max_latency_ms"], 1, 86_400_000)
    integer(payload["sla"]["availability_basis_points"], 0, 10_000)
    exact_fields(payload["pricing"], {"currency", "amount_minor", "payment_due_days"})
    if payload["pricing"]["currency"] not in ("USD", "EUR", "GBP"):
        raise ContractVerificationError("This schema supports USD/EUR/GBP integer cents/pence")
    integer(payload["pricing"]["amount_minor"], 1, 10**15)
    integer(payload["pricing"]["payment_due_days"], 0, 3650)
    if type(payload["terms"]) is not list or not 1 <= len(payload["terms"]) <= 32:
        raise ContractVerificationError("Expected 1 to 32 contractual terms")
    for term in payload["terms"]:
        text(term)
    if len(canonical_json(payload)) > 64 * 1024:
        raise ContractVerificationError("Contract exceeds 64 KiB")
    return payload


def verify_signatures(payload, signatures):
    validate_contract(payload)
    exact_fields(signatures, ROLES)
    verify_role_signatures(payload, signatures, payload["parties"])


def verify_role_signatures(body, signatures, parties):
    exact_fields(signatures, ROLES)
    for role in ROLES:
        hex_value(signatures[role], 128)
        try:
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(parties[role]["public_key"])).verify(
                bytes.fromhex(signatures[role]), canonical_json(body))
        except (InvalidSignature, ValueError) as error:
            raise ContractVerificationError(f"Invalid {role} Ed25519 signature") from error


def signed_package(payload, signatures):
    verify_signatures(payload, signatures)
    return snapshot({"schema_version": PACKAGE_SCHEMA, "contract": payload, "signatures": signatures})


@dataclass(frozen=True)
class SigningAgent:
    agent_id: str
    role: str
    private_key: Ed25519PrivateKey = field(repr=False)
    approve: Callable[[dict], bool] = field(default=lambda _: True, repr=False)

    def __post_init__(self):
        text(self.agent_id, 128)
        if self.role not in ROLES or not isinstance(self.private_key, Ed25519PrivateKey):
            raise ContractVerificationError("Expected a client/vendor Ed25519 signing agent")

    @classmethod
    def generate(cls, agent_id, role, approve=lambda _: True):
        return cls(agent_id, role, Ed25519PrivateKey.generate(), approve)

    @property
    def public_key(self):
        return self.private_key.public_key().public_bytes_raw().hex()

    def _check_identity(self, contract):
        validate_contract(contract)
        if contract["parties"][self.role] != {"agent_id": self.agent_id, "public_key": self.public_key}:
            raise ContractVerificationError("Signer does not match the designated contract party")

    def sign_contract(self, contract):
        self._check_identity(contract)
        if self.approve(snapshot(contract)) is not True:
            raise ContractVerificationError(f"{self.role} rejected the proposed terms")
        return self.private_key.sign(canonical_json(contract)).hex()

    def sign_receipt(self, body, package):
        self._check_identity(package["contract"])
        verify_signatures(package["contract"], package["signatures"])
        exact_fields(body, {"schema_version", "contract_id", "nonce", "parties",
                            "contract_hash", "contract_signatures", "expiration_utc",
                            "generated_utc", "anchoring"})
        if body["schema_version"] != RECEIPT_SCHEMA:
            raise ContractVerificationError("Agent refused an unsupported receipt schema")
        for name in ("contract_id", "nonce", "expiration_utc"):
            if body[name] != package["contract"][name]:
                raise ContractVerificationError("Agent refused conflicting receipt terms")
        if (body["contract_hash"] != sha256(package)
                or body["parties"] != package["contract"]["parties"]
                or body["contract_signatures"] != package["signatures"]
                or body["anchoring"]["hash"] != sha256(package)):
            raise ContractVerificationError("Agent refused a receipt for a different agreement")
        return self.private_key.sign(canonical_json(body)).hex()
