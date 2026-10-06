# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Distribution namespace and identity-preserving legacy routing regressions."""

import ast
import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SDK = Path(__file__).resolve().parents[1] / "sdk" / "python"
if str(SDK) not in sys.path:
    sys.path.insert(0, str(SDK))

import bitcoin_stratigraphy_enterprise as enterprise

MODULES = (
    "article_12_compliance",
    "article_12_journal",
    "audit_verifier",
    "audit_verifier_ots",
    "b2b_settlement",
    "b2b_contract",
    "b2b_settlement_verifier",
    "swarm_flight_recorder",
    "swarm_flight_evidence",
    "swarm_merkle",
)


class EnterprisePackageTests(unittest.TestCase):
    def test_every_legacy_module_is_the_same_implementation_object(self):
        for name in MODULES:
            with self.subTest(module=name):
                old = importlib.import_module(f"cookbooks.{name}")
                new = importlib.import_module(f"bitcoin_stratigraphy_enterprise.{name}")
                self.assertIs(old, new)
                self.assertTrue(Path(new.__file__).is_relative_to(SDK))

    def test_legacy_mock_targets_affect_sdk_globals(self):
        from bitcoin_stratigraphy_enterprise import swarm_flight_recorder as recorder
        from bitcoin_stratigraphy_enterprise import swarm_flight_evidence as evidence

        sentinel = object()
        with patch("cookbooks.swarm_flight_recorder.PrepaidMacroNotarizer", sentinel):
            self.assertIs(recorder.PrepaidMacroNotarizer, sentinel)
        with patch("cookbooks.swarm_flight_evidence.checked_header", sentinel):
            self.assertIs(evidence.checked_header, sentinel)

    def test_public_exports_resolve_without_network_calls(self):
        with patch(
            "urllib.request.OpenerDirector.open",
            side_effect=AssertionError("Unexpected network"),
        ):
            for name in enterprise.__all__:
                self.assertIsNotNone(getattr(enterprise, name))
        with self.assertRaises(AttributeError):
            getattr(enterprise, "does_not_exist")

    def test_self_contained_imports_and_transport_parity(self):
        for path in (SDK / "bitcoin_stratigraphy_enterprise").glob("*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.ImportFrom) and node.module:
                    self.assertFalse(
                        node.module.split(".")[0] in {"cookbooks", "sdk"}, path
                    )
        # Until the base Python transport migrates too, do not let the packaged
        # prepaid transport drift from its existing, tested implementation.
        self.assertEqual(
            (SDK / "client.py").read_text(),
            (SDK / "bitcoin_stratigraphy_enterprise" / "client.py").read_text(),
        )

    def test_public_recorder_and_article12_local_only_usage(self):
        from bitcoin_stratigraphy_enterprise import (
            Article12NotaryCallback,
            SwarmFlightRecorder,
            verify_inclusion_proof,
        )
        from bitcoin_stratigraphy_enterprise.article_12_compliance import (
            MissingBatchCredential,
        )

        class LocalOnly:
            def notarize(self, digest):
                raise MissingBatchCredential("Offline test")

        recorder = SwarmFlightRecorder()
        index = recorder.record_trace({"decision": "deny synthetic export"})
        recorder.flush_root()
        bundle = recorder.export_disclosure(index)
        result = verify_inclusion_proof(
            bundle["trace"], bundle["merkle_proof"], bundle["root_receipt"]
        )
        self.assertTrue(result["merkle_inclusion_verified"])
        self.assertFalse(result["bitcoin_inclusion_verified"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "journal.jsonl"
            with Article12NotaryCallback(
                journal_path=path, notarizer=LocalOnly()
            ) as callback:
                run_id = callback.start_run({"input": "synthetic"})
                callback.finish_run(run_id, {"output": "denied"})
            self.assertTrue(path.is_file())
            self.assertIn("deferred", path.read_text())
