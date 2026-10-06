# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Offline selective disclosure: Merkle inclusion, recorder seal, and OTS evidence."""
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation, VerificationError

from .article_12_journal import canonical_json
from .audit_verifier import strict_json
from .audit_verifier_ots import deserialize, checked_header, VerificationUnavailable
from .swarm_merkle import verify_merkle_inclusion, MAX_LEAVES

LEAF_SCHEMA = "saai-swarm-leaf/1"
PROOF_SCHEMA = "saai-swarm-inclusion/1"
RECEIPT_SCHEMA = "saai-swarm-root/1"
LIMITATIONS = (
    "Selective disclosure is a salted Merkle audit path, not a zero-knowledge proof. "
    "Undisclosed plaintext stays local; sibling hashes, tree size and leaf position are disclosed. "
    "A recorder seal proves key possession, not corporate authority or complete/honest telemetry. "
    "Bitcoin inclusion requires auditor-controlled validated mainnet headers, never receipt-supplied headers. "
    "Pending OTS is not Bitcoin inclusion. Block timestamps are not exact legal UTC clocks."
)


class DisclosureError(ValueError):
    """Malformed, substituted or cryptographically inconsistent disclosure."""


def fields(value, expected):
    if type(value) is not dict or set(value) != set(expected):
        raise DisclosureError("Unexpected or missing disclosure fields")


def hex_bytes(value, length):
    if type(value) is not str or len(value) != length * 2:
        raise DisclosureError("Invalid hex length")
    try:
        decoded = bytes.fromhex(value)
    except ValueError as error:
        raise DisclosureError("Invalid hex encoding") from error
    if len(decoded) != length or decoded.hex() != value:
        raise DisclosureError("Hex must be canonical lowercase")
    return decoded


def trace_bytes(payload):
    if type(payload) is not dict:
        raise DisclosureError("Trace must be a JSON object")
    encoded = canonical_json(payload)
    if len(encoded) > 64 * 1024:
        raise DisclosureError("Trace exceeds 64 KiB")
    # Reject duplicate/coerced keys and unsupported JSON values.
    if strict_json(encoded) != payload:
        raise DisclosureError("Trace must use JSON-native values and string keys")
    return encoded


def leaf_preimage(payload, salt):
    hex_bytes(salt, 32)
    trace_bytes(payload)
    return canonical_json({"schema_version": LEAF_SCHEMA, "salt": salt, "trace": payload})


def ots_receipt(proof_hex, root):
    if type(proof_hex) is not str or not 0 < len(proof_hex) <= 1024 * 1024 or len(proof_hex) % 2:
        raise DisclosureError("Invalid bounded OTS proof")
    binary = hex_bytes(proof_hex, len(proof_hex) // 2)
    return deserialize(binary, root)


def verify_inclusion_proof(trace_payload, merkle_proof, anchored_root_receipt, *,
                           trusted_headers=None, upgraded_ots_proof_hex=None,
                           expected_recorder_key=None):
    """No network/payment access. Distinguish membership from Bitcoin confirmation.

    trusted_headers is an independently obtained validated-mainnet height map,
    with block_hash/header_hex. Supply OTS upgrades separately from sealed receipts.
    """
    try:
        trace_payload = strict_json(trace_bytes(trace_payload))
        merkle_proof = strict_json(canonical_json(merkle_proof))
        anchored_root_receipt = strict_json(canonical_json(anchored_root_receipt))
        if trusted_headers is not None:
            if type(trusted_headers) is not dict:
                raise DisclosureError("Trusted headers must be an auditor-controlled map")
            trusted_headers = strict_json(canonical_json(trusted_headers))
        fields(merkle_proof, {"schema_version", "batch_id", "leaf_index", "tree_size", "leaf_salt", "path"})
        fields(anchored_root_receipt, {"body", "signature"})
        body = anchored_root_receipt["body"]
        fields(body, {"schema_version", "batch_id", "tree_size", "root_hash", "recorder_public_key", "anchoring"})
        if body["schema_version"] != RECEIPT_SCHEMA or merkle_proof["schema_version"] != PROOF_SCHEMA:
            raise DisclosureError("Unsupported evidence schema")
        if type(body["batch_id"]) is not str or not 1 <= len(body["batch_id"]) <= 128:
            raise DisclosureError("Invalid batch identifier")
        if type(body["tree_size"]) is not int or not 1 <= body["tree_size"] <= MAX_LEAVES:
            raise DisclosureError("Invalid sealed tree size")
        if (merkle_proof["batch_id"] != body["batch_id"]
                or merkle_proof["tree_size"] != body["tree_size"]):
            raise DisclosureError("Proof belongs to a different batch")
        key = hex_bytes(body["recorder_public_key"], 32)
        if expected_recorder_key is not None:
            hex_bytes(expected_recorder_key, 32)
            if expected_recorder_key != body["recorder_public_key"]:
                raise DisclosureError("Recorder differs from the independently pinned key")
        Ed25519PublicKey.from_public_bytes(key).verify(
            hex_bytes(anchored_root_receipt["signature"], 64), canonical_json(body))
        if type(merkle_proof["path"]) is not list or len(merkle_proof["path"]) > 20:
            raise DisclosureError("Invalid bounded audit path")
        siblings = [hex_bytes(value, 32) for value in merkle_proof["path"]]
        root = hex_bytes(body["root_hash"], 32)
        if not verify_merkle_inclusion(
                leaf_preimage(trace_payload, merkle_proof["leaf_salt"]), merkle_proof["leaf_index"],
                merkle_proof["tree_size"], siblings, root):
            raise DisclosureError("Trace does not hash to the sealed root")
        anchor = body["anchoring"]
        fields(anchor, {"status", "otsProofHex", "settlement_unknown"})
        if type(anchor["settlement_unknown"]) is not bool:
            raise DisclosureError("Invalid uncertainty flag")
        result = {
            "merkle_inclusion_verified": True, "receipt_signature_valid": True,
            "recorder_key_pinned": expected_recorder_key is not None,
            "bitcoin_inclusion_verified": False, "root_hash": root.hex(),
            "status": anchor["status"], "block_height": None, "block_timestamp": None,
            "limitations": LIMITATIONS,
        }
        if anchor["status"] in ("deferred", "unavailable"):
            if (anchor["otsProofHex"] is not None or upgraded_ots_proof_hex is not None
                    or anchor["settlement_unknown"] != (anchor["status"] == "unavailable")):
                raise DisclosureError("Inconsistent unanchored receipt")
            result["detail"] = ("Deferred/Pending Credential" if anchor["status"] == "deferred"
                                else "Notary outcome uncertain; do not automatically retry or repay")
            return result
        if anchor["status"] != "pending_calendar" or anchor["settlement_unknown"]:
            raise DisclosureError("Invalid anchoring state")
        original = ots_receipt(anchor["otsProofHex"], root.hex())
        proof = ots_receipt(upgraded_ots_proof_hex, root.hex()) if upgraded_ots_proof_hex is not None else original
        attestations = list(proof.timestamp.all_attestations())
        bitcoin = [(message, att) for message, att in attestations if isinstance(att, BitcoinBlockHeaderAttestation)]
        if not bitcoin:
            pending = any(isinstance(att, PendingAttestation) for _, att in attestations)
            result.update(status="pending" if pending else "unavailable",
                          detail="Pending Calendar; Bitcoin inclusion not proven" if pending else "No usable attestation")
            return result
        if not trusted_headers:
            result.update(status="unavailable", detail="Independently trusted mainnet headers required")
            return result
        verified = []
        for message, att in bitcoin:
            header_data = trusted_headers.get(att.height, trusted_headers.get(str(att.height)))
            if header_data is None:
                continue
            fields(header_data, {"block_hash", "header_hex"})
            hex_bytes(header_data["block_hash"], 32)
            hex_bytes(header_data["header_hex"], 80)
            header = checked_header(header_data["header_hex"], header_data["block_hash"])
            att.verify_against_blockheader(message, header)
            verified.append((header.nTime, att.height))
        if not verified:
            result.update(status="unavailable", detail="Trusted headers do not cover these attestations")
            return result
        timestamp, height = min(verified)
        result.update(status="verified_bitcoin", bitcoin_inclusion_verified=True,
                      block_height=height, block_timestamp=timestamp,
                      detail="Trace committed to independently validated Bitcoin evidence")
        return result
    except DisclosureError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError, OverflowError,
            InvalidSignature, VerificationUnavailable, VerificationError) as error:
        raise DisclosureError("Malformed or mismatched selective disclosure evidence") from error
