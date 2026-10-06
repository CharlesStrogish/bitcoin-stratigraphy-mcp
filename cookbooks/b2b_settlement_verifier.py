"""Offline contract/receipt verification. No MCP, payments, or network requests."""
from __future__ import annotations

from datetime import datetime, timezone

from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation

from cookbooks.article_12_journal import sha256
from cookbooks.audit_verifier_ots import EvidenceMismatch, VerificationUnavailable, checked_header, deserialize
from cookbooks.b2b_contract import (
    RECEIPT_SCHEMA, ContractVerificationError, exact_fields, hex_value, signed_package,
    snapshot, utc, validate_contract, verify_role_signatures,
)

LIMITATIONS = (
    "Agent keys prove possession, not corporate identity or signing authority. "
    "Offline Bitcoin inclusion relies on headers separately trusted by the auditor's "
    "fully validating mainnet node; receipt-supplied headers are not a trust source. "
    "A block's miner-declared timestamp is not an exact UTC/legal deadline clock. "
    "No contract funds, delivery, SLA performance, legal enforceability or global "
    "nonce uniqueness are verified. This is bilateral agreement, not Byzantine swarm consensus."
)


def checked_ots(proof_hex, digest):
    if (type(proof_hex) is not str or len(proof_hex) > 1024 * 1024
            or len(proof_hex) % 2 or not proof_hex):
        raise ContractVerificationError("Invalid bounded OTS receipt encoding")
    try:
        proof = bytes.fromhex(proof_hex)
        if proof.hex() != proof_hex:
            raise ValueError("Noncanonical OTS hex")
        return deserialize(proof, digest)
    except (ValueError, EvidenceMismatch) as error:
        raise ContractVerificationError("OTS proof does not bind the signed contract package") from error


def verify_contract_settlement(receipt, contract_payload, *, trusted_headers=None,
                               upgraded_ots_proof_hex=None, expected_party_keys=None):
    """Validate signatures and exact terms without contacting any remote service.

    trusted_headers: auditor-supplied height -> {block_hash, header_hex} obtained
    independently from a validated mainnet node/checkpointed chain, NOT a map
    read from this receipt. A raw header's PoW alone cannot establish mainnet
    membership. Upgrade evidence may be supplied separately without rewriting
    the original mutually sealed receipt.

    Signature/proof tampering raises ContractVerificationError. Pending,
    unavailable and late anchors return explicit, non-confirmed result states.
    """
    try:
        receipt, payload = snapshot(receipt), snapshot(contract_payload)
        validate_contract(payload)
        if expected_party_keys is not None:
            exact_fields(expected_party_keys, {"client", "vendor"})
            for role, key in expected_party_keys.items():
                hex_value(key, 64)
                if payload["parties"][role]["public_key"] != key:
                    raise ContractVerificationError("Contract key differs from independently pinned enterprise key")
        exact_fields(receipt, {"body", "receipt_signatures"})
        body = receipt["body"]
        exact_fields(body, {"schema_version", "contract_id", "nonce", "parties",
                            "contract_hash", "contract_signatures", "expiration_utc",
                            "generated_utc", "anchoring"})
        if body["schema_version"] != RECEIPT_SCHEMA:
            raise ContractVerificationError("Unsupported settlement receipt schema")
        utc(body["generated_utc"])
        for key in ("contract_id", "nonce", "parties", "expiration_utc"):
            if body[key] != payload[key]:
                raise ContractVerificationError(f"Receipt {key} does not match the contract")
        package = signed_package(payload, body["contract_signatures"])
        digest = sha256(package)
        if body["contract_hash"] != digest:
            raise ContractVerificationError("Signed package SHA-256 mismatch")
        verify_role_signatures(body, receipt["receipt_signatures"], payload["parties"])
        anchor = body["anchoring"]
        exact_fields(anchor, {"status", "hash", "otsProofHex", "settlement_unknown"})
        if anchor["hash"] != digest or type(anchor["settlement_unknown"]) is not bool:
            raise ContractVerificationError("Invalid anchoring metadata binding")
        result = {
            "contract_hash": digest, "contract_signatures_valid": True,
            "receipt_signatures_valid": True, "bitcoin_inclusion_verified": False,
            "party_keys_pinned": expected_party_keys is not None,
            "header_timestamp_before_expiration": None, "status": anchor["status"],
            "block_height": None, "block_timestamp_utc": None,
            "limitations": LIMITATIONS,
        }
        if anchor["status"] in ("deferred", "unavailable"):
            if anchor["otsProofHex"] is not None or upgraded_ots_proof_hex is not None:
                raise ContractVerificationError("Unanchored receipt cannot claim proof evidence")
            result["detail"] = ("Deferred/Pending Credential" if anchor["status"] == "deferred"
                                else "Notarization unavailable; outcome may be uncertain. Do not auto-repay.")
            return result
        if anchor["status"] != "pending_calendar" or anchor["settlement_unknown"]:
            raise ContractVerificationError("Unsupported anchoring status")
        original = checked_ots(anchor["otsProofHex"], digest)
        proof = (checked_ots(upgraded_ots_proof_hex, digest)
                 if upgraded_ots_proof_hex is not None else original)
        attestations = [(message, attestation) for message, attestation in proof.timestamp.all_attestations()
                        if isinstance(attestation, BitcoinBlockHeaderAttestation)]
        if not attestations:
            if not any(isinstance(a, PendingAttestation) for _, a in proof.timestamp.all_attestations()):
                result.update(status="unavailable", detail="No Bitcoin or pending calendar attestation")
            else:
                result.update(status="pending", detail="Pending Calendar; expiration is not yet proven")
            return result
        if not trusted_headers:
            result.update(status="unavailable", detail="Bitcoin attestation needs independently trusted mainnet headers")
            return result
        verified = []
        for message, attestation in attestations:
            header_data = trusted_headers.get(attestation.height, trusted_headers.get(str(attestation.height)))
            if header_data is None:
                continue
            exact_fields(header_data, {"block_hash", "header_hex"})
            hex_value(header_data["block_hash"], 64)
            hex_value(header_data["header_hex"], 160)
            header = checked_header(header_data["header_hex"], header_data["block_hash"])
            try:
                attestation.verify_against_blockheader(message, header)
            except Exception as error:
                raise ContractVerificationError("Bitcoin Merkle commitment mismatch") from error
            verified.append((header.nTime, attestation.height))
        if not verified:
            result.update(status="unavailable", detail="Trusted headers do not cover the OTS attestations")
            return result
        block_time, height = min(verified)
        before = block_time < utc(payload["expiration_utc"]).timestamp()
        result.update(
            status="verified_header_time" if before else "after_expiration",
            bitcoin_inclusion_verified=True, header_timestamp_before_expiration=before,
            block_height=height,
            block_timestamp_utc=datetime.fromtimestamp(block_time, timezone.utc).isoformat().replace("+00:00", "Z"),
            detail=("Contract commitment verified in independently trusted Bitcoin evidence; "
                    "block timestamp precedes expiration, subject to block-clock limitations" if before
                    else "Bitcoin inclusion verified, but the block timestamp is not before expiration"),
        )
        return result
    except ContractVerificationError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError,
            VerificationUnavailable) as error:
        raise ContractVerificationError("Malformed contract, settlement receipt or trusted evidence") from error
