# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Enterprise evidence tooling: local capture, selective disclosure and auditing.

Frameworks are optional. Importing this namespace performs no network or payment
operations. Evidence is not a legal certification or a zero-knowledge proof.
"""
from importlib import import_module

__version__ = "0.2.0"

_EXPORTS = {
    "SwarmFlightRecorder": ("swarm_flight_recorder", "SwarmFlightRecorder"),
    "Article12NotaryCallback": ("article_12_compliance", "Article12NotaryCallback"),
    "MacroNotarizer": ("article_12_compliance", "MacroNotarizer"),
    "AuditJournal": ("article_12_journal", "AuditJournal"),
    "B2BSettlementProtocol": ("b2b_settlement", "B2BSettlementProtocol"),
    "PrepaidMacroNotarizer": ("b2b_settlement", "PrepaidMacroNotarizer"),
    "SigningAgent": ("b2b_contract", "SigningAgent"),
    "verify_inclusion_proof": ("swarm_flight_evidence", "verify_inclusion_proof"),
    "verify_contract_settlement": ("b2b_settlement_verifier", "verify_contract_settlement"),
    "audit_journal": ("audit_verifier", "audit_journal"),
    "OtsVerifier": ("audit_verifier_ots", "OtsVerifier"),
}

__all__ = list(_EXPORTS)


def __getattr__(name):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module, symbol = _EXPORTS[name]
    value = getattr(import_module(f".{module}", __name__), symbol)
    globals()[name] = value
    return value
