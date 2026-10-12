# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Fail-closed entry-point checks without changing the uploaded license."""

import contextlib
import io
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.exceptions import InvalidSignature

import main as entrypoint


class LicenseStartupTests(unittest.TestCase):
    def run_startup(self, **verifier_options):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.object(entrypoint, "verify_license", **verifier_options) as check,
            patch.object(entrypoint, "start_engine") as start_engine,
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            try:
                entrypoint.main()
                code = 0
            except SystemExit as exc:
                code = exc.code
            self.assertEqual(start_engine.call_count, 1 if code == 0 else 0)
        return code, stdout.getvalue(), stderr.getvalue(), check

    def assert_denied(self, **verifier_options):
        code, stdout, stderr, _ = self.run_startup(**verifier_options)
        self.assertEqual(code, 1)
        self.assertIn("ACCESS DENIED", stderr)
        self.assertNotIn("Welcome", stdout)
        self.assertNotIn("Hello", stdout)

    def test_valid_license_allows_startup(self):
        code, stdout, stderr, check = self.run_startup(return_value=True)
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")
        self.assertIn("Welcome to Bitcoin Stratigraphy Enterprise", stdout)
        self.assertNotIn("Hello from repl-nix-workspace!", stdout)
        check.assert_called_once_with(
            Path(entrypoint.__file__).resolve().with_name("acme_corp.lic")
        )

    def test_expired_license_halts(self):
        self.assert_denied(return_value=False)

    def test_missing_license_halts(self):
        self.assert_denied(side_effect=FileNotFoundError())

    def test_invalid_signature_halts(self):
        self.assert_denied(side_effect=InvalidSignature())

    def test_malformed_license_halts(self):
        self.assert_denied(side_effect=ValueError("Malformed JSON"))

    def test_missing_license_fields_halt(self):
        self.assert_denied(side_effect=KeyError("payload"))

    def test_only_true_authorizes_startup(self):
        for value in (None, 1, "true"):
            with self.subTest(value=value):
                self.assert_denied(return_value=value)


if __name__ == "__main__":
    unittest.main()
