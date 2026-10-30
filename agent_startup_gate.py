# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""ASGI gate that holds Enterprise Agent API requests while the application loads.

Imported by :func:`agent_startup.serve` only after the port is listening, so
the event-loop machinery it needs never delays the bind.
"""

import asyncio
import collections
import json
import logging
import threading
import time

from agent_startup import STARTUP_FAILURE

# Long enough for a slow cold boot. A request that waits longer, or arrives
# while MAX_HELD_REQUESTS others are waiting, receives a 503 with Retry-After.
MAX_HOLD_SECONDS = 60.0
MAX_HELD_REQUESTS = 1024
RETRY_AFTER_SECONDS = 5
# A waiting request's body is read ahead, up to this many bytes, so that a
# client disconnect is noticed; the application later receives the same
# messages in order. The rest of a larger body waits under flow control.
MAX_READ_AHEAD_BYTES = 64 * 1024

STARTING = "Enterprise Agent API is starting; retry shortly"
UNAVAILABLE = "Enterprise Agent API is unavailable; retry shortly"

logger = logging.getLogger("uvicorn.error")


class LifespanFailure(Exception):
    """The application reported a failed lifespan startup or shutdown."""


def _resolve(future, error=None):
    if future.done():
        return
    if error is None:
        future.set_result(None)
    else:
        future.set_exception(error)


def _consume(future):
    # Retrieve an outcome nobody awaits, so asyncio does not report it as lost.
    if future.done() and not future.cancelled():
        future.exception()


async def _call_in_daemon_thread(function):
    """Like asyncio.to_thread, but an unfinished call never delays process exit.

    asyncio.run waits for its default executor's threads before returning, so a
    shutdown requested mid-import would otherwise wait for the import to end.
    """
    loop = asyncio.get_running_loop()
    outcome = loop.create_future()

    def deliver(result, error):
        if outcome.done():
            return  # The caller stopped waiting.
        if error is None:
            outcome.set_result(result)
        else:
            outcome.set_exception(error)

    def run():
        result = error = None
        try:
            result = function()
        except BaseException as exc:  # Includes SystemExit from a license denial.
            error = exc
        try:
            loop.call_soon_threadsafe(deliver, result, error)
        except RuntimeError:
            pass  # The event loop has closed; nobody is waiting any more.

    threading.Thread(target=run, name="agent-api-loader", daemon=True).start()
    return await outcome


class _ApplicationLifespan:
    """Runs an ASGI application's lifespan protocol the way uvicorn does."""

    def __init__(self, app, state):
        loop = asyncio.get_running_loop()
        self._app = app
        self._state = state
        self._messages = asyncio.Queue()
        self._started = loop.create_future()
        self._stopped = loop.create_future()
        self._failure_reported = False
        self._task = None

    async def startup(self):
        self._task = asyncio.ensure_future(self._run())
        self._messages.put_nowait({"type": "lifespan.startup"})
        try:
            await self._outcome(self._started)
        except asyncio.CancelledError:
            # Abandon a startup still in progress; the application's own
            # cleanup (finally blocks, exit stacks) runs before this returns.
            self._task.cancel()
            await asyncio.wait([self._task])
            _consume(self._started)
            raise

    async def shutdown(self):
        if self._task.done():
            return
        self._messages.put_nowait({"type": "lifespan.shutdown"})
        await self._outcome(self._stopped)

    async def _run(self):
        scope = {"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}}
        if self._state is not None:
            scope["state"] = self._state
        try:
            await self._app(scope, self._messages.get, self._send)
        except BaseException:
            # Contained as uvicorn contains it, including SystemExit from the
            # license re-check: reported failures surface through startup() or
            # shutdown() instead.
            if not self._failure_reported:
                logger.info("ASGI 'lifespan' protocol appears unsupported.")

    async def _send(self, message):
        kind = message["type"]
        if kind == "lifespan.startup.complete":
            _resolve(self._started)
        elif kind == "lifespan.shutdown.complete":
            _resolve(self._stopped)
        elif kind in ("lifespan.startup.failed", "lifespan.shutdown.failed"):
            self._failure_reported = True
            target = (
                self._started if kind == "lifespan.startup.failed" else self._stopped
            )
            _resolve(target, LifespanFailure(message.get("message", "")))

    async def _outcome(self, reported):
        await asyncio.wait([reported, self._task], return_when=asyncio.FIRST_COMPLETED)
        if reported.done():
            reported.result()
        # Otherwise the application ended without answering: like uvicorn,
        # treat it as running without a lifespan.


class _ReadAhead:
    """Watches a waiting HTTP request for a client disconnect.

    Request messages read while watching are replayed to the application, in
    order, before its receive() reaches the server again.
    """

    def __init__(self, receive):
        self._receive = receive
        self._messages = collections.deque()
        self._buffered = 0
        self.disconnected = False

    async def watch(self):
        while self._buffered <= MAX_READ_AHEAD_BYTES:
            message = await self._receive()
            if message["type"] == "http.disconnect":
                self.disconnected = True
                return
            self._messages.append(message)
            self._buffered += len(message.get("body", b""))

    async def receive(self):
        if self._messages:
            return self._messages.popleft()
        return await self._receive()


class StartupGate:
    """ASGI application that stands in for an application which is still loading.

    The gate completes the server's lifespan startup at once, calls
    ``load_app`` in a background thread, then runs the loaded application's own
    lifespan startup. Requests wait until that has completed (up to
    ``max_hold`` seconds each, at most ``max_held`` at a time) and then go to
    the application unchanged. If loading or startup fails, waiting and new
    requests receive a 503, ``exit_code`` is set and ``on_failure`` is called
    so the server can stop.
    """

    def __init__(
        self,
        load_app,
        *,
        max_hold=MAX_HOLD_SECONDS,
        max_held=MAX_HELD_REQUESTS,
        retry_after=RETRY_AFTER_SECONDS,
        on_failure=None,
        listening_since=None,
    ):
        self.app = None
        self.exit_code = None
        self.held = 0
        self.on_failure = on_failure
        self._load_app = load_app
        self._max_hold = max_hold
        self._max_held = max_held
        self._retry_after = str(retry_after).encode("ascii")
        self._listening_since = listening_since
        self._released = asyncio.Event()
        self._closing = False
        self._loop = None
        self._loader = None
        self._lifespan = None
        self._state = None

    @property
    def _stopping(self):
        return self.exit_code is not None or self._closing

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            host = dict(scope.get("headers", [])).get(b"host", b"")
            hostname = host.lower().rsplit(b":", 1)[0].rstrip(b".")
            if any(
                hostname == domain or hostname.endswith(b"." + domain)
                for domain in (b"replit.app", b"replit.dev", b"repl.co")
            ):
                raw_path = scope.get("raw_path", scope["path"].encode("utf-8"))
                raw_path = raw_path if raw_path.startswith(b"/") else b"/"
                query = scope.get("query_string", b"")
                location = b"https://bitcoinstratigraphy.com" + raw_path
                if query:
                    location += b"?" + query
                await send({
                    "type": "http.response.start",
                    "status": 301,
                    "headers": [(b"location", location), (b"content-length", b"0")],
                })
                await send({"type": "http.response.body", "body": b""})
                return
        if scope["type"] == "lifespan":
            await self._serve_lifespan(scope, receive, send)
        elif self.app is not None:
            await self.app(scope, receive, send)
        else:
            await self._hold(scope, receive, send)

    def request_close(self):
        """Answer waiting requests now. Safe to call from a signal handler."""
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._begin_close)

    async def _hold(self, scope, receive, send):
        if self._stopping or self.held >= self._max_held:
            await self._refuse(scope, send)
            return
        reader = _ReadAhead(receive) if scope["type"] == "http" else None
        self.held += 1
        try:
            await self._wait(reader)
        finally:
            self.held -= 1
        if reader is not None and reader.disconnected:
            return  # Nobody is waiting for the answer.
        if self.app is None:
            await self._refuse(scope, send)
            return
        state = scope.get("state")
        if isinstance(state, dict) and self._state:
            # Requests accepted from now on start from the lifespan state.
            for key, value in self._state.items():
                state.setdefault(key, value)
        await self.app(scope, receive if reader is None else reader.receive, send)

    async def _wait(self, reader):
        deadline = time.monotonic() + self._max_hold
        released = asyncio.ensure_future(self._released.wait())
        watcher = None if reader is None else asyncio.ensure_future(reader.watch())
        pending = {released} if watcher is None else {released, watcher}
        try:
            while released in pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                done, pending = await asyncio.wait(
                    pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
                )
                if watcher in done and reader.disconnected:
                    break
        finally:
            released.cancel()
            if watcher is not None:
                watcher.cancel()
                # Its pending receive() must end before the application reads.
                await asyncio.wait([watcher])
                _consume(watcher)

    async def _refuse(self, scope, send):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1013})
            return
        if scope["type"] != "http":
            return
        body = json.dumps(
            {"detail": UNAVAILABLE if self._stopping else STARTING}
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 503,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                    (b"retry-after", self._retry_after),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _serve_lifespan(self, scope, receive, send):
        await receive()  # lifespan.startup
        self._loop = asyncio.get_running_loop()
        self._state = scope.get("state")
        if self._listening_since is None:
            self._listening_since = time.monotonic()
        self._loader = asyncio.ensure_future(self._load())
        await send({"type": "lifespan.startup.complete"})
        await receive()  # lifespan.shutdown
        try:
            await self._close()
        except LifespanFailure as exc:
            await send({"type": "lifespan.shutdown.failed", "message": str(exc)})
        else:
            await send({"type": "lifespan.shutdown.complete"})

    async def _load(self):
        began = time.monotonic()
        try:
            app = await _call_in_daemon_thread(self._load_app)
            loaded = time.monotonic()
            if self._closing:
                return
            lifespan = _ApplicationLifespan(app, self._state)
            await lifespan.startup()
        except asyncio.CancelledError:
            raise
        except LifespanFailure as exc:
            if str(exc):
                logger.error(str(exc))
            logger.error("Application startup failed. Exiting.")
            self._fail(STARTUP_FAILURE)
            return
        except SystemExit as exc:
            # The application refused to load; a license denial prints why.
            code = exc.code if isinstance(exc.code, int) and exc.code else 1
            logger.error("Enterprise Agent API failed to load (exit status %d).", code)
            self._fail(code)
            return
        except BaseException:
            logger.exception("Enterprise Agent API failed to load.")
            self._fail(1)
            return
        self._lifespan = lifespan
        self.app = app
        waiting = self.held
        self._released.set()
        ready = time.monotonic()
        logger.info(
            "Enterprise Agent API ready %.0f ms after the port opened (loaded in "
            "%.0f ms, started in %.0f ms); %d waiting request(s) released.",
            (ready - self._listening_since) * 1000,
            (loaded - began) * 1000,
            (ready - loaded) * 1000,
            waiting,
        )

    def _fail(self, code):
        self.exit_code = code
        self._released.set()
        if self.on_failure is not None:
            self.on_failure()

    def _begin_close(self):
        self._closing = True
        self._released.set()

    async def _close(self):
        self._begin_close()
        if self._loader is not None:
            if not self._loader.done():
                self._loader.cancel()
                await asyncio.wait([self._loader])
            _consume(self._loader)
        if self._lifespan is not None:
            lifespan, self._lifespan = self._lifespan, None
            await lifespan.shutdown()
