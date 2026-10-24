# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Daily scheduling, actual OTS serialization, archive integrity and downloads."""

import asyncio
import base64
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi_mcp import FastApiMCP
from opentimestamps.calendar import DEFAULT_AGGREGATORS
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.serialize import BytesSerializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

import provenance_anchor as anchor
from provenance_routes import register_provenance_routes
from stratigraphy_pipeline import PipelineUnavailable, calculate_stratigraphy_metrics
from provenance_fixtures import MemoryArchive
from provenance_storage import StorageUnavailable


def serialize(value):
    context = BytesSerializationContext()
    value.serialize(context)
    return context.getbytes()


def snapshot():
    return calculate_stratigraphy_metrics(971036, 83504.715, 1e21, "https://api.coinbase.com/v2/prices/BTC-USD/spot")


def receipt(body, *, bitcoin=False):
    detached = DetachedTimestampFile.from_fd(OpSHA256(), io.BytesIO(body))
    detached.timestamp.attestations.add(
        BitcoinBlockHeaderAttestation(971040) if bitcoin else
        PendingAttestation("https://alice.btc.calendar.opentimestamps.org")
    )
    return serialize(detached)


def calendar(request):
    if request.url.path != "/digest" or request.method != "POST":
        raise AssertionError("Unexpected calendar operation")
    # These are deterministic calendar fixtures, not network-confirmed Bitcoin proofs.
    stamp = Timestamp(request.content)
    stamp.attestations.add(PendingAttestation("https://alice.btc.calendar.opentimestamps.org"))
    return httpx.Response(200, content=serialize(stamp))


class ProofTests(unittest.TestCase):
    def test_utc_midnight_schedule_and_year_rollover(self):
        instant = datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        self.assertEqual(anchor.next_midnight_utc(instant), datetime(2027, 1, 1, tzinfo=timezone.utc))
        midnight = datetime(2027, 1, 1, tzinfo=timezone.utc)
        self.assertEqual((anchor.next_midnight_utc(midnight) - midnight).total_seconds(), 86400)

    def test_date_validation(self):
        self.assertEqual(anchor.validate_date("2024-02-29"), "2024-02-29")
        for value in ("2026-02-29", "2026-1-01", "../2026-10-12", "20261012", "", "2026-10-12\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                anchor.validate_date(value)

    def test_exact_bytes_binding_and_unverified_status(self):
        body = b'{"hello":"Bitcoin"}\n'
        self.assertEqual(anchor.proof_status(body, receipt(body)), "pending_bitcoin_confirmation")
        self.assertEqual(anchor.proof_status(body, receipt(body, bitcoin=True)), "bitcoin_attestation_present_unverified")
        for wrong_body, wrong_proof in ((body + b"\n", receipt(body)), (body, b"not OTS"), (body, receipt(body) + b"extra")):
            with self.assertRaises(anchor.ProofUnavailable):
                anchor.proof_status(wrong_body, wrong_proof)

    def test_symlink_refused_and_snapshot_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "snapshot.json"
            anchor.save_once(path, b"first")
            with self.assertRaises(FileExistsError):
                anchor.save_once(path, b"second")
            self.assertEqual(path.read_bytes(), b"first")
            link = Path(folder) / "link"
            link.symlink_to(path)
            with self.assertRaises(anchor.ProofUnavailable):
                anchor.read_archive_file(link)
            self.assertFalse(list(Path(folder).glob("*.tmp")))


class AnchorTests(unittest.IsolatedAsyncioTestCase):
    async def test_cloud_only_incomplete_snapshot_resumes_after_redeployment(self):
        day = datetime.now(timezone.utc).date().isoformat()
        storage = MemoryArchive()
        original = snapshot().model_dump_json().encode()
        storage.put(day, original)
        def unavailable_pipeline():
            raise AssertionError("Historical cloud capture must not be recreated")
        with tempfile.TemporaryDirectory() as empty_directory:
            async with httpx.AsyncClient(transport=httpx.MockTransport(calendar)) as client:
                service = anchor.ProvenanceAnchor(
                    SimpleNamespace(get_snapshot=unavailable_pipeline), client,
                    directory=empty_directory, storage=storage,
                )
                await service.start()
                try:
                    async with asyncio.timeout(2):
                        while storage.key(day, proof=True) not in storage.objects:
                            await asyncio.sleep(0.01)
                finally:
                    await service.stop()
                self.assertEqual(storage.load(day)[0], original)
                self.assertFalse(list(Path(empty_directory).glob("snapshot*")))

    async def test_existing_local_completed_archives_migrate_without_restamping(self):
        day = "2009-01-03"
        body = snapshot().model_dump_json().encode()
        proof = receipt(body)
        storage = MemoryArchive()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / f"snapshot_{day}.json"
            path.write_bytes(body)
            path.with_suffix(".json.ots").write_bytes(proof)
            async with httpx.AsyncClient() as client:
                service = anchor.ProvenanceAnchor(None, client, directory=folder, storage=storage)
                with patch.object(anchor, "stamp_snapshot", AsyncMock()) as stamp:
                    await service.anchor_date(day)
                    stamp.assert_not_awaited()
                self.assertEqual(storage.load(day)[:2], (body, proof))

    async def test_failed_proof_upload_keeps_exact_receipt_for_retry(self):
        day = datetime.now(timezone.utc).date().isoformat()
        storage = MemoryArchive()
        real_put = storage.put
        def put(day, body, *, proof=False):
            if proof:
                raise StorageUnavailable("test interrupted proof upload")
            return real_put(day, body)
        with tempfile.TemporaryDirectory() as folder:
            async with httpx.AsyncClient(transport=httpx.MockTransport(calendar)) as client:
                service = anchor.ProvenanceAnchor(
                    SimpleNamespace(get_snapshot=snapshot), client, directory=folder, storage=storage,
                )
                with patch.object(storage, "put", put):
                    with self.assertRaises(StorageUnavailable):
                        await service.anchor_date(day)
                path = Path(folder) / f"snapshot_{day}.json.ots"
                original_proof = path.read_bytes()
                with patch.object(anchor, "stamp_snapshot", AsyncMock()) as stamp:
                    await service.anchor_date(day)
                    stamp.assert_not_awaited()
                self.assertEqual(storage.get(day, proof=True), original_proof)

    async def test_cloud_snapshot_wins_over_conflicting_local_capture(self):
        day = datetime.now(timezone.utc).date().isoformat()
        cloud = snapshot().model_dump_json().encode()
        storage = MemoryArchive()
        storage.put(day, cloud)
        with tempfile.TemporaryDirectory() as folder:
            # Another instance had a different JSON serialization and receipt.
            local = cloud + b"\n"
            path = Path(folder) / f"snapshot_{day}.json"
            path.write_bytes(local)
            path.with_suffix(".json.ots").write_bytes(receipt(local))
            async with httpx.AsyncClient(transport=httpx.MockTransport(calendar)) as client:
                service = anchor.ProvenanceAnchor(None, client, directory=folder, storage=storage)
                await service.anchor_date(day)
                self.assertEqual(storage.load(day)[0], cloud)
                self.assertEqual(anchor.proof_status(cloud, storage.get(day, proof=True)), "pending_bitcoin_confirmation")

    async def test_scheduler_captures_once_per_midnight_not_at_startup(self):
        class Clock(datetime):
            current = datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc)

            @classmethod
            def now(cls, _timezone=None):
                return cls.current

        with tempfile.TemporaryDirectory() as folder:
            service = anchor.ProvenanceAnchor(None, None, directory=folder, storage=MemoryArchive())
            captured = []

            async def capture(day):
                self.assertEqual(Clock.current.hour, 0)
                self.assertEqual(Clock.current.minute, 0)
                self.assertEqual(Clock.current.second, 0)
                captured.append(day)

            async def advance(seconds):
                if len(captured) == 2:
                    raise asyncio.CancelledError()
                Clock.current += timedelta(seconds=seconds)

            service.anchor_date = capture
            with (
                patch.object(anchor, "datetime", Clock),
                patch.object(anchor.asyncio, "sleep", advance),
                self.assertRaises(asyncio.CancelledError),
            ):
                await service._run()
            self.assertEqual(captured, ["2027-01-01", "2027-01-02"])

    async def test_start_delay_defers_resuming_but_not_the_midnight_capture(self):
        class Clock(datetime):
            current = datetime(2026, 12, 31, 23, 58, tzinfo=timezone.utc)

        Clock.now = classmethod(lambda cls, _timezone=None: cls.current)
        booted = Clock.current
        with tempfile.TemporaryDirectory() as folder:
            storage = MemoryArchive()
            service = anchor.ProvenanceAnchor(None, None, directory=folder, storage=storage, start_delay=300)
            surveys, captured = [], []

            def days():
                surveys.append(Clock.current)
                return set(), set()

            async def capture(day):
                captured.append((day, Clock.current))

            async def advance(seconds):
                if surveys:
                    raise asyncio.CancelledError()
                Clock.current += timedelta(seconds=seconds)

            storage.days = days
            service.anchor_date = capture
            with (
                patch.object(anchor, "datetime", Clock),
                patch.object(anchor.asyncio, "sleep", advance),
                self.assertRaises(asyncio.CancelledError),
            ):
                await service._run()
        # Booted two minutes before midnight: the new UTC day is still captured
        # on schedule, while the first archive survey waits for the delay.
        self.assertEqual(captured, [("2027-01-01", datetime(2027, 1, 1, tzinfo=timezone.utc))])
        self.assertEqual(len(surveys), 1)
        self.assertGreaterEqual(surveys[0], booted + timedelta(seconds=300))
        with self.assertRaises(ValueError):
            anchor.ProvenanceAnchor(None, None, storage=MemoryArchive(), start_delay=-1)

    async def test_mcp_executor_delivers_exact_json_and_binary_proof(self):
        with tempfile.TemporaryDirectory() as folder:
            day = "2026-10-12"
            body = (snapshot().model_dump_json(indent=2) + "\n").encode()
            proof = receipt(body)
            path = Path(folder) / f"snapshot_{day}.json"
            path.write_bytes(body)
            path.with_suffix(".json.ots").write_bytes(proof)
            app = FastAPI()
            register_provenance_routes(app, MemoryArchive.from_directory(Path(folder)), "/agent-api")
            async with httpx.AsyncClient(
                base_url="http://test", transport=httpx.ASGITransport(app=app)
            ) as client:
                mcp = FastApiMCP(app, http_client=client, include_operations=["get_historical_proof"])
                content = await mcp._execute_api_tool(
                    client, "get_historical_proof", {"date": day}, mcp.operation_map
                )
                manifest = json.loads(content[0].text)
                self.assertEqual(manifest["snapshot_json"].encode("utf-8"), body)
                self.assertEqual(base64.b64decode(manifest["ots_proof_base64"]), proof)
                self.assertEqual(manifest["proof_status"], "pending_bitcoin_confirmation")

    async def test_stamp_default_calendars_with_blinding_and_exact_file_binding(self):
        digests = []
        def responder(request):
            digests.append(request.content)
            return calendar(request)
        body = snapshot().model_dump_json().encode()
        async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
            proof = await anchor.stamp_snapshot(body, client)
        self.assertEqual(len(digests), len(DEFAULT_AGGREGATORS))
        self.assertTrue(all(digest == digests[0] for digest in digests))
        self.assertNotEqual(digests[0], hashlib.sha256(body).digest())
        self.assertEqual(anchor.proof_status(body, proof), "pending_bitcoin_confirmation")

    async def test_default_two_calendar_quorum_and_malformed_responses(self):
        calls = 0
        def responder(request):
            nonlocal calls
            calls += 1
            return calendar(request) if calls == 1 else httpx.Response(200, content=b"malformed")
        async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
            with self.assertRaises(anchor.ProofUnavailable):
                await anchor.stamp_snapshot(b"snapshot", client)

    async def test_limits_and_timeouts_are_not_saved_as_proofs(self):
        for mode in ("oversized", "timeout"):
            def responder(_request):
                if mode == "timeout":
                    raise httpx.ReadTimeout("test")
                return httpx.Response(200, content=b"x" * 10001)
            async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
                with self.assertRaises(anchor.ProofUnavailable):
                    await anchor.stamp_snapshot(b"snapshot", client)

    async def test_daily_capture_idempotent_and_retry_keeps_original_bytes(self):
        day = datetime.now(timezone.utc).date().isoformat()
        metrics = snapshot()
        pipe = SimpleNamespace(get_snapshot=lambda: metrics)
        with tempfile.TemporaryDirectory() as folder:
            async with httpx.AsyncClient(transport=httpx.MockTransport(calendar)) as client:
                service = anchor.ProvenanceAnchor(pipe, client, directory=folder, storage=MemoryArchive())
                with patch.object(anchor, "stamp_snapshot", AsyncMock(side_effect=anchor.ProofUnavailable())):
                    with self.assertRaises(anchor.ProofUnavailable):
                        await service.anchor_date(day)
                path = Path(folder) / f"snapshot_{day}.json"
                original = path.read_bytes()
                self.assertEqual(json.loads(original)["block_height"], metrics.block_height)
                pipe.get_snapshot = lambda: (_ for _ in ()).throw(AssertionError("Must not recapture"))
                await service.anchor_date(day)
                saved_proof = path.with_suffix(".json.ots").read_bytes()
                await service.anchor_date(day)
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(path.with_suffix(".json.ots").read_bytes(), saved_proof)
                self.assertEqual(anchor.load_historical_proof(Path(folder), day)[0], original)

    async def test_unavailable_live_state_cannot_create_snapshot(self):
        def no_snapshot():
            raise PipelineUnavailable()
        with tempfile.TemporaryDirectory() as folder:
            async with httpx.AsyncClient(transport=httpx.MockTransport(calendar)) as client:
                service = anchor.ProvenanceAnchor(SimpleNamespace(get_snapshot=no_snapshot), client, directory=folder, storage=MemoryArchive())
                with self.assertRaises(PipelineUnavailable):
                    await service.anchor_date(datetime.now(timezone.utc).date().isoformat())
                self.assertFalse(list(Path(folder).glob("snapshot*")))
                with self.assertRaises(anchor.ProofUnavailable):
                    await service.anchor_date("2009-01-03")

    async def test_archive_lock_prevents_competing_workers(self):
        with tempfile.TemporaryDirectory() as folder:
            day = datetime.now(timezone.utc).date().isoformat()
            async with httpx.AsyncClient(transport=httpx.MockTransport(calendar)) as client:
                service = anchor.ProvenanceAnchor(SimpleNamespace(get_snapshot=snapshot), client, directory=folder, storage=MemoryArchive())
                with anchor.day_lock(Path(folder), day):
                    with self.assertRaises(anchor.ProofUnavailable):
                        await service.anchor_date(day)

    async def test_start_is_not_an_extra_capture_and_shutdown_cancels_requests(self):
        day = datetime.now(timezone.utc).date().isoformat()
        entered = asyncio.Event()
        active = 0
        async def hanging(_request):
            nonlocal active
            active += 1
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                active -= 1
        with tempfile.TemporaryDirectory() as folder:
            async with httpx.AsyncClient(transport=httpx.MockTransport(hanging)) as client:
                service = anchor.ProvenanceAnchor(SimpleNamespace(get_snapshot=snapshot), client, directory=folder, storage=MemoryArchive())
                await service.start()
                original_task = service._task
                await service.start()
                self.assertIs(service._task, original_task)
                await asyncio.sleep(0)
                self.assertFalse(list(Path(folder).glob("snapshot*")))
                await service.stop()
                self.assertTrue(original_task.done())
                # A saved snapshot without its proof is retried after restart.
                path = Path(folder) / f"snapshot_{day}.json"
                path.write_bytes(snapshot().model_dump_json().encode())
                await service.start()
                async with asyncio.timeout(1):
                    await entered.wait()
                    await service.stop()
                self.assertEqual(active, 0)
                self.assertFalse(path.with_suffix(".json.ots").exists())


class DownloadTests(unittest.TestCase):
    def test_cloud_downloads_survive_loss_of_entire_local_archive(self):
        day = "2026-10-12"
        body = snapshot().model_dump_json().encode()
        proof = receipt(body)
        storage = MemoryArchive()
        storage.put(day, body)
        storage.put(day, proof, proof=True)
        # The read path has no local directory parameter or filesystem fallback.
        app = FastAPI()
        register_provenance_routes(app, storage, "/agent-api")
        with TestClient(app) as client:
            manifest = client.get("/agent-api/historical-proof", params={"date": day}).json()
            self.assertEqual(client.get(manifest["snapshot_download_url"]).content, body)
            self.assertEqual(client.get(manifest["ots_download_url"]).content, proof)

    def test_storage_create_only_and_bounded_reads(self):
        storage = MemoryArchive()
        day = "2026-10-12"
        self.assertEqual(storage.put(day, b"original"), b"original")
        self.assertEqual(storage.put(day, b"replacement"), b"original")
        storage.objects[storage.key(day)] = b"x" * (anchor.MAX_FILE_SIZE + 1)
        with self.assertRaises(anchor.ProofUnavailable):
            storage.get(day)
        storage.fail_download = True
        with self.assertRaises(StorageUnavailable):
            storage.get(day)

    def test_json_mcp_manifest_and_exact_downloads_and_zip(self):
        with tempfile.TemporaryDirectory() as folder:
            day = "2026-10-12"
            body = (snapshot().model_dump_json(indent=2) + "\n").encode()
            proof = receipt(body)
            path = Path(folder) / f"snapshot_{day}.json"
            path.write_bytes(body)
            path.with_suffix(".json.ots").write_bytes(proof)
            app = FastAPI()
            storage = MemoryArchive.from_directory(Path(folder))
            register_provenance_routes(app, storage, "/agent-api")
            with TestClient(app) as client:
                response = client.get("/agent-api/historical-proof", params={"date": day})
                self.assertEqual(response.status_code, 200)
                manifest = response.json()
                self.assertEqual(manifest["snapshot_json"].encode(), body)
                self.assertEqual(base64.b64decode(manifest["ots_proof_base64"]), proof)
                self.assertEqual(manifest["snapshot_sha256"], hashlib.sha256(body).hexdigest())
                self.assertEqual(manifest["proof_status"], "pending_bitcoin_confirmation")
                for key, expected in (("snapshot_download_url", body), ("ots_download_url", proof)):
                    downloaded = client.get(manifest[key])
                    self.assertEqual(downloaded.content, expected)
                    self.assertIn("attachment", downloaded.headers["Content-Disposition"])
                archive = client.get(manifest["bundle_download_url"])
                self.assertEqual(archive.headers["Content-Type"], "application/zip")
                with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
                    self.assertEqual(bundle.read(path.name), body)
                    self.assertEqual(bundle.read(path.name + ".ots"), proof)
                for invalid in ("../../acme_corp.lic", "2026-02-30"):
                    self.assertEqual(client.get("/agent-api/historical-proof", params={"date": invalid}).status_code, 422)
                self.assertEqual(client.get("/agent-api/historical-proof", params={"date": "2026-10-13"}).status_code, 404)
                del storage.objects[storage.key(day, proof=True)]
                self.assertEqual(client.get("/agent-api/historical-proof", params={"date": day}).status_code, 409)
                storage.objects[storage.key(day, proof=True)] = proof
                storage.objects[storage.key(day)] = body + b"\n"
                self.assertEqual(client.get("/agent-api/historical-proof", params={"date": day}).status_code, 409)
                storage.fail_download = True
                self.assertEqual(client.get("/agent-api/historical-proof", params={"date": day}).status_code, 503)


if __name__ == "__main__":
    unittest.main()
