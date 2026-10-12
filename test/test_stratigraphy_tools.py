"""MCP's canonical source must be live metrics and cloud-bound proof bytes."""

import base64
import hashlib
import hmac
import io
import json
import os
import time
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.serialize import BytesSerializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile

from provenance_fixtures import MemoryArchive
from stratigraphy_bridge import register_stratigraphy_bridge
from stratigraphy_pipeline import PipelineUnavailable, calculate_stratigraphy_metrics


def receipt(snapshot, *, mined=False):
    detached = DetachedTimestampFile.from_fd(OpSHA256(), io.BytesIO(snapshot))
    detached.timestamp.attestations.add(
        BitcoinBlockHeaderAttestation(970001) if mined
        else PendingAttestation("https://alice.btc.calendar.opentimestamps.org")
    )
    context = BytesSerializationContext()
    detached.serialize(context)
    return context.getbytes()


class Pipeline:
    def __init__(self, metrics):
        self.metrics = metrics
        self.ready = True

    def get_snapshot(self):
        if not self.ready:
            raise PipelineUnavailable()
        return self.metrics


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"SESSION_SECRET": "local-test-only-secret"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.storage = MemoryArchive()
        self.live = calculate_stratigraphy_metrics(971100, 80000, 1e21, "test-live-price")
        self.app = FastAPI()
        self.app.state.stratigraphy_pipeline = Pipeline(self.live)
        register_stratigraphy_bridge(self.app, self.storage, "/agent-api")
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def query(self, tool, arguments=None, *, nonce="a" * 32):
        payload = json.dumps({"tool": tool, "arguments": arguments or {}}, separators=(",", ":"))
        timestamp = str(int(time.time()))
        sig = hmac.new(
            os.environ["SESSION_SECRET"].encode(),
            f"{timestamp}\n{nonce}\n{payload}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return self.client.post(
            "/agent-api/internal/stratigraphy", content=payload,
            headers={
                "x-stratigraphy-time": timestamp,
                "x-stratigraphy-nonce": nonce,
                "x-stratigraphy-signature": sig,
            },
        )

    def archive(self, day, *, height=971000, mined=False):
        metrics = calculate_stratigraphy_metrics(height, 100000, 0.8e21, "test-archive-price")
        body = (json.dumps(metrics.model_dump(), separators=(",", ":")) + "\n").encode()
        proof = receipt(body, mined=mined)
        self.storage.put(day, body)
        self.storage.put(day, proof, proof=True)
        return body, proof

    def test_no_legacy_fallback_and_live_model_exact(self):
        free = self.query("stratigraphy.list")
        self.assertEqual(free.status_code, 200)
        self.assertEqual(free.json()["result"]["totalSnapshots"], 0)
        self.assertNotIn("btc_price_usd", free.json()["result"])
        paid = self.query("stratigraphy.get", nonce="b" * 32)
        self.assertEqual(paid.status_code, 200)
        result = paid.json()
        self.assertEqual(result["targetHeights"], [971100])
        self.assertEqual(result["result"]["records"][0]["block_height"], 971100)
        self.assertEqual(result["result"]["live_metrics"]["efficiency_baseline_j_th"], 15)
        self.assertEqual(result["result"]["live_metrics"]["network_energy_watts"], 15e9)
        self.assertEqual(result["result"]["live_metrics"]["hal_finney_horizon_multiple"], 125)
        self.assertIn("Hal Finney", result["result"]["live_metrics"]["attribution"])
        self.assertFalse(result["result"]["proofAvailable"])
        self.assertEqual(result["result"]["archive_state"], "no_archives")
        self.assertEqual(result["result"]["historical_proofs"], [])

    def test_latest_cloud_proof_overwrite_visible_without_cached_bytes(self):
        body, proof = self.archive("2026-10-12")
        first = self.query("stratigraphy.get")
        self.assertEqual(first.status_code, 200)
        assert first.json()["result"]["historical_proofs"][0]["ots_proof_base64"] == base64.b64encode(proof).decode()
        key = self.storage.key("2026-10-12", proof=True)
        replacement = receipt(body, mined=True)
        self.storage.objects[key] = replacement  # Emulate the six-hour conditional cloud replacement.
        second = self.query("stratigraphy.get", nonce="b" * 32)
        self.assertEqual(second.status_code, 200)
        manifest = second.json()["result"]["historical_proofs"][0]
        self.assertEqual(base64.b64decode(manifest["ots_proof_base64"]), replacement)
        self.assertEqual(manifest["snapshot_json"].encode(), body)
        self.assertEqual(manifest["snapshot_sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(manifest["proof_status"], "bitcoin_attestation_present_unverified")
        self.assertEqual(sorted(second.json()["targetHeights"]), [971000, 971100])

    def test_all_five_tools_use_real_height_and_fail_missing_targets(self):
        self.archive("2026-10-11", height=970000)
        self.archive("2026-10-12", height=971000)
        cases = [
            ("stratigraphy.list", {}),
            ("stratigraphy.get", {"blockHeight": 971000}),
            ("stratigraphy.get_digest", {"target": "971000", "format": "kv"}),
            ("stratigraphy.get_diff", {"fromTarget": "970000"}),
            ("stratigraphy.get_range", {"startTarget": "970000", "format": "minimal"}),
        ]
        for index, (name, args) in enumerate(cases):
            with self.subTest(tool=name):
                response = self.query(name, args, nonce=f"{index:032x}")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["result"]["live_metrics"]["block_height"], 971100) if index else None
                if index:
                    self.assertEqual(len(response.json()["result"]["historical_proofs"]), 2 if index == 4 else 1)
        missing = self.query("stratigraphy.get", {"blockHeight": 9999}, nonce="a1" * 16)
        self.assertEqual(missing.status_code, 404)

    def test_storage_failure_and_incomplete_proof_do_not_fall_back(self):
        self.archive("2026-10-12")
        del self.storage.objects[self.storage.key("2026-10-12", proof=True)]
        incomplete = self.query("stratigraphy.get", {"date": "2026-10-12"})
        self.assertEqual(incomplete.status_code, 409)
        self.storage.fail_download = True
        unavailable = self.query("stratigraphy.get", {"date": "2026-10-12"}, nonce="b" * 32)
        self.assertEqual(unavailable.status_code, 503)
        self.app.state.stratigraphy_pipeline.ready = False
        self.assertEqual(self.query("stratigraphy.list", nonce="c" * 32).status_code, 503)

    def test_requires_internal_auth_and_rejects_replay(self):
        unauthenticated = self.client.post("/agent-api/internal/stratigraphy", json={"tool": "stratigraphy.list", "arguments": {}})
        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(self.query("stratigraphy.list").status_code, 200)
        self.assertEqual(self.query("stratigraphy.list").status_code, 401)


if __name__ == "__main__":
    unittest.main()
