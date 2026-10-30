# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Listen-first Enterprise Agent API launcher: waiting requests, failures, shutdown."""

import asyncio
import contextlib
import http.client
import io
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx

import agent_api
import agent_startup
import agent_startup_gate
import main
import stratigraphy_pipeline as pipeline
from agent_startup_gate import STARTING, UNAVAILABLE, StartupGate
from provenance_fixtures import MemoryArchive

ROOT = Path(__file__).resolve().parents[1]
MCP_HEADERS = {"accept": "application/json, text/event-stream"}
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "startup-test", "version": "1.0"},
    },
}


async def until(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("Timed out waiting for the launcher")
        await asyncio.sleep(0.005)


def raising(error):
    def factory():
        raise error

    return factory


class Loader:
    """load_app stand-in that blocks its loader thread until the test releases it."""

    def __init__(self, factory):
        self.factory = factory
        self.release = threading.Event()
        self.finished = threading.Event()

    def __call__(self):
        try:
            if not self.release.wait(30):
                raise RuntimeError("The test never released the loader")
            return self.factory()
        finally:
            self.finished.set()


class GateHarness:
    """Drives a gate's lifespan as uvicorn does, including the shared state dict."""

    def __init__(self, gate):
        self.gate = gate
        self.state = {}
        self.inbox = asyncio.Queue()
        self.outbox = []
        self.task = None

    async def start(self):
        scope = {
            "type": "lifespan",
            "asgi": {"version": "3.0", "spec_version": "2.0"},
            "state": self.state,
        }

        async def send(message):
            self.outbox.append(message)

        self.task = asyncio.ensure_future(self.gate(scope, self.inbox.get, send))
        self.inbox.put_nowait({"type": "lifespan.startup"})
        await until(lambda: self.outbox)
        assert self.outbox == [{"type": "lifespan.startup.complete"}], self.outbox

    async def stop(self):
        self.inbox.put_nowait({"type": "lifespan.shutdown"})
        await asyncio.wait_for(self.task, 10)
        return self.outbox[-1]


class Exchange:
    """One HTTP request through the gate, with a controllable client side."""

    def __init__(self, harness, *, chunks=(b"",), path="/echo"):
        self.inbox = asyncio.Queue()
        for index, chunk in enumerate(chunks):
            more = index < len(chunks) - 1
            self.inbox.put_nowait(
                {"type": "http.request", "body": chunk, "more_body": more}
            )
        self.outbox = []
        self.scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [],
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 8000),
            # uvicorn gives every request a copy of the lifespan state.
            "state": harness.state.copy(),
        }
        self.task = asyncio.ensure_future(
            harness.gate(self.scope, self.inbox.get, self.send)
        )

    async def send(self, message):
        self.outbox.append(message)

    def disconnect(self):
        self.inbox.put_nowait({"type": "http.disconnect"})

    async def finished(self):
        await asyncio.wait_for(self.task, 10)
        return self

    @property
    def status(self):
        return self.outbox[0]["status"]

    @property
    def headers(self):
        return dict(self.outbox[0]["headers"])

    @property
    def body(self):
        return b"".join(message.get("body", b"") for message in self.outbox[1:])


class EchoApp:
    """ASGI application that records its lifespan and echoes request bodies."""

    def __init__(self, *, fail_startup=False, block_startup=False):
        self.events = []
        self.requests = []
        self.fail_startup = fail_startup
        self.block_startup = block_startup

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            await self.lifespan(scope, receive, send)
            return
        chunks = []
        while True:
            message = await receive()
            assert message["type"] == "http.request", message
            chunks.append(message["body"])
            if not message["more_body"]:
                break
        self.requests.append(scope)
        greeting = scope["state"].get("greeting", "").encode()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"x-greeting", greeting)],
            }
        )
        await send({"type": "http.response.body", "body": b"".join(chunks)})

    async def lifespan(self, scope, receive, send):
        await receive()
        self.events.append("startup")
        try:
            if self.block_startup:
                await asyncio.Event().wait()
            if self.fail_startup:
                message = "database unreachable"
                await send({"type": "lifespan.startup.failed", "message": message})
                return
            scope["state"]["greeting"] = "hello"
            await send({"type": "lifespan.startup.complete"})
            await receive()
            self.events.append("shutdown")
            await send({"type": "lifespan.shutdown.complete"})
        finally:
            self.events.append("cleanup")


class RefusalAssertions:
    def assert_refused(self, exchange, detail):
        body = json.dumps({"detail": detail}).encode()
        self.assertEqual(exchange.status, 503)
        self.assertEqual(exchange.body, body)
        self.assertEqual(
            exchange.headers,
            {
                b"content-type": b"application/json",
                b"content-length": str(len(body)).encode(),
                b"cache-control": b"no-store",
                b"retry-after": b"5",
            },
        )


class StartupGateTests(RefusalAssertions, unittest.IsolatedAsyncioTestCase):
    async def test_legacy_host_redirects_before_loading_without_changing_local_access(self):
        calls = []

        async def application(scope, receive, send):
            calls.append(scope)
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        gate = StartupGate(lambda: application)
        for host in (b"old.replit.app", b"OLD.REPLIT.DEV:443", b"old.repl.co."):
            messages = []

            async def send(message):
                messages.append(message)

            scope = {
                "type": "http", "path": "/agent-api/mcp",
                "raw_path": b"/agent-api/mcp", "query_string": b"trace=a%2Fb&x=1",
                "headers": [(b"host", host)],
            }
            await gate(scope, None, send)
            self.assertEqual(messages[0]["status"], 301)
            self.assertEqual(dict(messages[0]["headers"])[b"location"],
                b"https://bitcoinstratigraphy.com/agent-api/mcp?trace=a%2Fb&x=1")
            self.assertEqual(messages[1]["body"], b"")
        self.assertEqual(calls, [])
        self.assertEqual(gate.held, 0)
        gate.app = application
        for host in (b"localhost", b"127.0.0.1:8000", b"[::1]:8000",
                     b"bitcoinstratigraphy.com", b"www.bitcoinstratigraphy.com",
                     b"old.replit.app.evil.example"):
            messages = []
            scope["headers"] = [(b"host", host), (b"x-forwarded-host", b"old.replit.app")]
            await gate(scope, None, send)
            self.assertEqual(messages[0]["status"], 200)
        self.assertEqual(len(calls), 6)

    async def start_gate(self, factory, **options):
        loader = Loader(factory)
        self.addCleanup(loader.release.set)
        gate = StartupGate(loader, **options)
        harness = GateHarness(gate)
        await harness.start()
        return gate, loader, harness

    async def test_waiting_request_reaches_the_application_after_its_startup(self):
        app = EchoApp()
        gate, loader, harness = await self.start_gate(lambda: app)
        held = Exchange(harness, chunks=(b"he", b"llo"))
        await until(lambda: gate.held == 1)
        await asyncio.sleep(0.05)
        self.assertEqual((held.outbox, app.events), ([], []))

        loader.release.set()
        await held.finished()
        self.assertEqual((held.status, held.body), (200, b"hello"))
        # State set by the application's lifespan reaches requests that waited.
        self.assertEqual(held.headers[b"x-greeting"], b"hello")
        self.assertEqual((gate.held, app.events), (0, ["startup"]))

        later = await Exchange(harness, chunks=(b"later",)).finished()
        self.assertEqual((later.status, later.body), (200, b"later"))
        self.assertEqual(later.headers[b"x-greeting"], b"hello")
        shutdown = await harness.stop()
        self.assertEqual(shutdown, {"type": "lifespan.shutdown.complete"})
        self.assertEqual(app.events, ["startup", "shutdown", "cleanup"])

    async def test_large_body_is_read_ahead_up_to_the_cap_and_replayed_in_order(self):
        app = EchoApp()
        gate, loader, harness = await self.start_gate(lambda: app)
        size = agent_startup_gate.MAX_READ_AHEAD_BYTES // 2
        chunks = [bytes([index]) * size for index in range(4)]
        held = Exchange(harness, chunks=chunks)
        await until(lambda: held.inbox.qsize() == 1)
        await asyncio.sleep(0.05)
        # The final chunk stays with the server until the application reads it.
        self.assertEqual(held.inbox.qsize(), 1)

        loader.release.set()
        await held.finished()
        self.assertEqual((held.status, held.body), (200, b"".join(chunks)))
        await harness.stop()

    async def test_request_waiting_past_the_hold_limit_gets_503_retry_after(self):
        app = EchoApp()
        gate, loader, harness = await self.start_gate(lambda: app, max_hold=0.2)
        began = time.monotonic()
        refused = await Exchange(harness).finished()
        self.assertGreaterEqual(time.monotonic() - began, 0.19)
        self.assert_refused(refused, STARTING)
        self.assertEqual(gate.held, 0)

        loader.release.set()
        await until(lambda: gate.app is app)
        self.assertEqual(app.requests, [])
        await harness.stop()

    async def test_requests_over_the_waiting_limit_and_websockets_are_refused(self):
        app = EchoApp()
        gate, loader, harness = await self.start_gate(lambda: app, max_held=1)
        held = Exchange(harness, chunks=(b"first",))
        await until(lambda: gate.held == 1)
        self.assert_refused(await Exchange(harness).finished(), STARTING)
        closed = []

        async def send(message):
            closed.append(message)

        websocket = {"type": "websocket", "path": "/ws", "headers": [], "state": {}}
        await gate(websocket, asyncio.Queue().get, send)
        self.assertEqual(closed, [{"type": "websocket.close", "code": 1013}])

        loader.release.set()
        await held.finished()
        self.assertEqual((held.status, held.body), (200, b"first"))
        await harness.stop()

    async def test_disconnected_client_frees_its_place_and_never_reaches_the_app(self):
        app = EchoApp()
        gate, loader, harness = await self.start_gate(lambda: app, max_held=1)
        gone = Exchange(harness, chunks=(b"gone",))
        await until(lambda: gate.held == 1)
        gone.disconnect()
        await gone.finished()
        self.assertEqual((gone.outbox, gate.held), ([], 0))

        kept = Exchange(harness, chunks=(b"kept",))
        await until(lambda: gate.held == 1)
        loader.release.set()
        await kept.finished()
        self.assertEqual((kept.status, kept.body), (200, b"kept"))
        self.assertEqual(len(app.requests), 1)
        await harness.stop()

    async def test_load_failure_answers_waiting_requests_and_stops_the_server(self):
        cases = [
            (SystemExit(1), 1),
            (SystemExit(4), 4),
            (SystemExit("license denied"), 1),
            (RuntimeError("import failed"), 1),
        ]
        for error, code in cases:
            with self.subTest(error=repr(error)):
                stop = Mock()
                gate, loader, harness = await self.start_gate(
                    raising(error), on_failure=stop
                )
                held = Exchange(harness)
                await until(lambda: gate.held == 1)
                with self.assertLogs("uvicorn.error", level="ERROR") as logs:
                    loader.release.set()
                    await held.finished()
                self.assertIn("failed to load", "\n".join(logs.output))
                self.assert_refused(held, UNAVAILABLE)
                self.assertEqual(gate.exit_code, code)
                stop.assert_called_once_with()
                self.assert_refused(await Exchange(harness).finished(), UNAVAILABLE)
                shutdown = await harness.stop()
                self.assertEqual(shutdown, {"type": "lifespan.shutdown.complete"})

    async def test_reported_startup_failure_exits_with_uvicorn_startup_status(self):
        app = EchoApp(fail_startup=True)
        stop = Mock()
        gate, loader, harness = await self.start_gate(lambda: app, on_failure=stop)
        held = Exchange(harness)
        await until(lambda: gate.held == 1)
        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            loader.release.set()
            await held.finished()
        self.assertEqual(
            logs.output,
            [
                "ERROR:uvicorn.error:database unreachable",
                "ERROR:uvicorn.error:Application startup failed. Exiting.",
            ],
        )
        self.assert_refused(held, UNAVAILABLE)
        self.assertEqual(gate.exit_code, agent_startup.STARTUP_FAILURE)
        stop.assert_called_once_with()
        shutdown = await harness.stop()
        self.assertEqual(shutdown, {"type": "lifespan.shutdown.complete"})
        self.assertEqual(app.events, ["startup", "cleanup"])

    async def test_close_while_loading_answers_waiting_requests_and_skips_startup(self):
        app = EchoApp()
        gate, loader, harness = await self.start_gate(lambda: app)
        held = Exchange(harness)
        await until(lambda: gate.held == 1)
        gate.request_close()  # Called by the server's signal handler.
        await held.finished()
        self.assert_refused(held, UNAVAILABLE)
        # Shutdown does not wait for the loader thread.
        shutdown = await harness.stop()
        self.assertEqual(shutdown, {"type": "lifespan.shutdown.complete"})

        loader.release.set()
        await until(loader.finished.is_set)
        await asyncio.sleep(0.05)
        self.assertEqual((gate.app, gate.exit_code, app.events), (None, None, []))

    async def test_shutdown_during_application_startup_runs_its_cleanup(self):
        app = EchoApp(block_startup=True)
        gate, loader, harness = await self.start_gate(lambda: app)
        loader.release.set()
        await until(lambda: app.events == ["startup"])
        shutdown = await harness.stop()
        self.assertEqual(shutdown, {"type": "lifespan.shutdown.complete"})
        self.assertEqual(app.events, ["startup", "cleanup"])
        self.assertIsNone(gate.app)


class AgentApiBehindGateTests(RefusalAssertions, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.proof_directory = Path(directory.name)

    async def asyncSetUp(self):
        # The application's lifespan builds TLS contexts synchronously; asyncio
        # debug mode, enabled by this test case, would report each as slow.
        asyncio.get_running_loop().slow_callback_duration = 5

    def create_app(self):
        return agent_api.create_app(
            proof_directory=self.proof_directory, proof_storage=MemoryArchive()
        )

    async def start_gate(self, *, release=True):
        loader = Loader(self.create_app)
        self.addCleanup(loader.release.set)
        if release:
            loader.release.set()
        gate = StartupGate(loader)
        harness = GateHarness(gate)
        await harness.start()
        return gate, loader, harness

    async def test_routes_pipeline_and_mcp_behave_unchanged_behind_the_gate(self):
        async def fixed_height(_client):
            return 900_001

        price = AsyncMock(return_value=(100_000, pipeline.PRICE_URL))
        with (
            patch.object(main, "verify_license", return_value=True) as verify,
            patch.object(pipeline, "read_live_height", fixed_height),
            patch.object(pipeline, "read_live_price", price),
            patch.object(pipeline, "read_live_hashrate", AsyncMock(return_value=1e21)),
        ):
            gate, loader, harness = await self.start_gate(release=False)
            transport = httpx.ASGITransport(app=gate)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://agent-api"
            ) as client:
                health = asyncio.ensure_future(client.get("/agent-api/health"))
                initialize = asyncio.ensure_future(
                    client.post("/agent-api/mcp", json=INITIALIZE, headers=MCP_HEADERS)
                )
                await until(lambda: gate.held == 2)
                loader.release.set()

                # Waiting requests are answered once the real lifespan has
                # started; the pipeline's first refresh no longer delays them,
                # so health may still report that it is in progress.
                health = await health
                self.assertEqual(health.status_code, 200)
                self.assertEqual(
                    {key: health.json()[key] for key in ("status", "service")},
                    {"status": "ok", "service": "enterprise-agent-api"},
                )
                self.assertIsInstance(health.json()["pipeline_ready"], bool)
                initialize = await initialize
                self.assertEqual(initialize.status_code, 200)
                server_info = initialize.json()["result"]["serverInfo"]
                self.assertEqual(
                    server_info["name"], "Bitcoin Stratigraphy Enterprise Supply"
                )
                session = {
                    **MCP_HEADERS,
                    "mcp-session-id": initialize.headers["mcp-session-id"],
                }
                notified = await client.post(
                    "/agent-api/mcp",
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                    headers=session,
                )
                self.assertEqual(notified.status_code, 202)
                tools = await client.post(
                    "/agent-api/mcp",
                    json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    headers=session,
                )
                self.assertEqual(
                    [tool["name"] for tool in tools.json()["result"]["tools"]],
                    ["get_supply_metrics", "get_historical_proof"],
                )

                schema = (await client.get("/agent-api/openapi.json")).json()
                operations = [
                    operation["operationId"]
                    for path in schema["paths"].values()
                    for operation in path.values()
                    if isinstance(operation, dict) and "operationId" in operation
                ]
                self.assertEqual(
                    operations, ["get_supply_metrics", "get_historical_proof"]
                )
                metrics = await client.get("/agent-api/supply-metrics")
                self.assertEqual(metrics.status_code, 200)
                self.assertEqual(metrics.json()["block_height"], 900_001)
                self.assertEqual(metrics.json()["hal_finney_horizon_multiple"], 100)
                self.assertEqual(metrics.json()["attribution"], pipeline.ATTRIBUTION)
                self.assertEqual(
                    (await client.get("/agent-api/health")).json(),
                    {
                        "status": "ok",
                        "service": "enterprise-agent-api",
                        "pipeline_ready": True,
                    },
                )
                index = await client.get("/agent-api")
                self.assertEqual(index.status_code, 307)
                self.assertEqual(index.headers["location"], "/agent-api/docs")

            app = gate.app
            await app.state.mcp.shutdown()
            shutdown = await harness.stop()
        self.assertEqual(shutdown, {"type": "lifespan.shutdown.complete"})
        self.assertIsNone(app.state.stratigraphy_pipeline._task)
        # create_app and the lifespan both re-check the license.
        self.assertEqual(verify.call_count, 2)
        price.assert_awaited_once()

    async def test_license_denied_while_loading_exits_with_status_1(self):
        stderr = io.StringIO()
        with (
            patch.object(main, "verify_license", return_value=False),
            contextlib.redirect_stderr(stderr),
            self.assertLogs("uvicorn.error", level="ERROR"),
        ):
            gate, loader, harness = await self.start_gate()
            await until(lambda: gate.exit_code is not None)
            refused = await Exchange(harness).finished()
            await harness.stop()
        self.assertEqual((gate.exit_code, gate.app), (1, None))
        self.assertIn("ACCESS DENIED", stderr.getvalue())
        self.assert_refused(refused, UNAVAILABLE)

    async def test_license_denied_at_lifespan_recheck_exits_with_startup_status(self):
        stderr = io.StringIO()
        with (
            patch.object(main, "verify_license", side_effect=[True, False]) as verify,
            contextlib.redirect_stderr(stderr),
            self.assertLogs("uvicorn.error", level="ERROR") as logs,
        ):
            gate, loader, harness = await self.start_gate()
            await until(lambda: gate.exit_code is not None)
            refused = await Exchange(harness).finished()
            await harness.stop()
        self.assertEqual(
            (gate.exit_code, gate.app), (agent_startup.STARTUP_FAILURE, None)
        )
        self.assertEqual(verify.call_count, 2)
        self.assertIn("ACCESS DENIED", stderr.getvalue())
        self.assertEqual(
            logs.output[-1], "ERROR:uvicorn.error:Application startup failed. Exiting."
        )
        self.assert_refused(refused, UNAVAILABLE)


class EntryPointTests(unittest.TestCase):
    def test_start_engine_serves_through_the_listen_first_launcher(self):
        with patch.object(agent_startup, "serve") as serve:
            main.start_engine()
        serve.assert_called_once_with()


# Serves a stand-in application through agent_startup.serve in a real process.
LAUNCHER_SCRIPT = r"""
import os, sys, time
import agent_startup

mode = os.environ["LAUNCH_MODE"]
delay = float(os.environ["LAUNCH_DELAY"])

async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                print("app startup", flush=True)
                await send({"type": "lifespan.startup.complete"})
            else:
                print("app shutdown", flush=True)
                await send({"type": "lifespan.shutdown.complete"})
                return
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"loaded"})

def load():
    time.sleep(delay)
    if mode == "exit":
        raise SystemExit(1)
    return app

if mode == "report-held":
    import agent_startup_gate

    wait = agent_startup_gate.StartupGate._wait

    async def report(self, reader):
        print("held", flush=True)
        return await wait(self, reader)

    agent_startup_gate.StartupGate._wait = report

agent_startup.serve(host="127.0.0.1", port=int(sys.argv[1]), load_app=load)
"""


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def http_get(port):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    try:
        connection.request("GET", "/agent-api/health")
        response = connection.getresponse()
        headers = {name.lower(): value for name, value in response.getheaders()}
        return response.status, headers, response.read()
    finally:
        connection.close()


class LauncherProcess:
    def __init__(self, test, port, *, mode="serve", delay=0.0):
        self.port = port
        self.lines = []
        self.changed = threading.Condition()
        environment = {
            **os.environ,
            "LAUNCH_MODE": mode,
            "LAUNCH_DELAY": str(delay),
            "PYTHONUNBUFFERED": "1",
        }
        self.process = subprocess.Popen(
            [sys.executable, "-c", LAUNCHER_SCRIPT, str(port)],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        test.addCleanup(self.close)

    def _read(self):
        for line in self.process.stdout:
            with self.changed:
                self.lines.append(line.rstrip("\n"))
                self.changed.notify_all()

    @property
    def output(self):
        with self.changed:
            return "\n".join(self.lines)

    def wait_for_line(self, text, timeout=20):
        with self.changed:
            printed = self.changed.wait_for(
                lambda: any(text in line for line in self.lines), timeout
            )
        if not printed:
            raise AssertionError(f"{text!r} was not printed:\n{self.output}")

    def wait_for_port(self, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError(f"Launcher exited early:\n{self.output}")
            with socket.socket() as probe:
                probe.settimeout(1)
                if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                    return time.monotonic()
            time.sleep(0.01)
        raise AssertionError(f"Port never opened:\n{self.output}")

    def wait(self, timeout=20):
        code = self.process.wait(timeout)
        self.reader.join(5)
        return code

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(10)
        self.reader.join(5)
        self.process.stdout.close()


class LauncherProcessTests(unittest.TestCase):
    def test_launcher_module_binds_before_loading_the_event_loop_machinery(self):
        # Everything agent_startup imports runs before the port is listening.
        code = (
            "import json, sys\n"
            "before = set(sys.modules)\n"
            "import agent_startup\n"
            "print(json.dumps(sorted(set(sys.modules) - before)))\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        added = set(json.loads(result.stdout)) - {"agent_startup"}
        self.assertTrue(
            all(name.partition(".")[0] in sys.stdlib_module_names for name in added),
            added,
        )
        loaded_later = {"asyncio", "uvicorn", "agent_startup_gate", "agent_api"}
        self.assertEqual(added & loaded_later, set())

    def test_port_opens_before_the_application_loads(self):
        launcher = LauncherProcess(self, free_port(), delay=2.0)
        opened = launcher.wait_for_port()
        self.assertNotIn("app startup", launcher.output)

        status, _, body = http_get(launcher.port)
        answered = time.monotonic()
        self.assertEqual((status, body), (200, b"loaded"))
        self.assertGreaterEqual(answered - opened, 1.9)
        launcher.wait_for_line("Enterprise Agent API ready")

        launcher.process.send_signal(signal.SIGTERM)
        self.assertEqual(launcher.wait(), -signal.SIGTERM)
        self.assertIn("app shutdown", launcher.output)

    def test_sigterm_answers_waiting_requests_without_waiting_for_the_load(self):
        launcher = LauncherProcess(self, free_port(), mode="report-held", delay=30.0)
        launcher.wait_for_port()
        result = {}
        request = threading.Thread(
            target=lambda: result.update(response=http_get(launcher.port))
        )
        request.start()
        launcher.wait_for_line("held")

        signalled = time.monotonic()
        launcher.process.send_signal(signal.SIGTERM)
        request.join(15)
        status, headers, body = result["response"]
        self.assertEqual(status, 503)
        self.assertEqual(headers["retry-after"], "5")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(json.loads(body), {"detail": UNAVAILABLE})
        self.assertEqual(launcher.wait(), -signal.SIGTERM)
        self.assertLess(time.monotonic() - signalled, 10)
        self.assertNotIn("app startup", launcher.output)

    def test_load_failure_exits_with_the_loaders_status(self):
        launcher = LauncherProcess(self, free_port(), mode="exit")
        self.assertEqual(launcher.wait(), 1)
        self.assertIn("failed to load (exit status 1)", launcher.output)

    def test_port_in_use_exits_with_startup_failure(self):
        with socket.socket() as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen()
            launcher = LauncherProcess(self, holder.getsockname()[1])
            self.assertEqual(launcher.wait(), agent_startup.STARTUP_FAILURE)
        self.assertIn("ERROR:", launcher.output)
        self.assertIn("Address already in use", launcher.output)


if __name__ == "__main__":
    unittest.main()
