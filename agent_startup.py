# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Listen-first launcher for the Enterprise Agent API.

``main.py`` verifies the enterprise license and then calls :func:`serve`, which
opens the HTTP port before anything else is imported: the server, the
request-holding gate (``agent_startup_gate``) and, in a background thread, the
application with its heavy dependencies (FastAPI, the MCP server, storage and
timestamping clients). Requests that arrive meanwhile wait, and are handed to
the application once its own lifespan startup has completed; from then on
every request goes straight to it. Without this, the platform proxy answers
HTTP 500 for as long as the port is closed after a publish.

Only these lightweight standard-library modules may be imported at module
level: everything imported here runs before the port is listening.
"""

import os
import socket
import sys
import time

LISTEN_BACKLOG = 2048
# uvicorn's exit status for a failed startup.
STARTUP_FAILURE = 3


def bind_listening_socket(host, port, backlog=LISTEN_BACKLOG):
    """Return a TCP socket whose connections already queue in the kernel."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(backlog)
    except BaseException:
        sock.close()
        raise
    return sock


def _load_agent_api():
    # Runs in a background thread once the port is listening. Importing the
    # module builds the application, which re-checks the enterprise license.
    #
    # httpx imports its optional command-line client (rich and pygments, about
    # 70 modules) whenever those packages are installed. The server never uses
    # it, so mark it unavailable; httpx then defines its standard fallback.
    sys.modules.setdefault("httpx._main", None)
    from agent_api import app

    return app


def _create_server(uvicorn, config, gate):
    class StartupServer(uvicorn.Server):
        def handle_exit(self, sig, frame):
            super().handle_exit(sig, frame)
            # Graceful shutdown waits for open requests; answer waiting ones
            # now instead of after their hold expires.
            gate.request_close()

    server = StartupServer(config)

    def stop():
        server.should_exit = True

    gate.on_failure = stop
    return server


def serve(*, host="0.0.0.0", port=None, load_app=_load_agent_api):
    """Listen on ``host:port`` (default ``$PORT``, else 8000), then load and serve.

    Call only after the enterprise license has been verified (see main.py).
    """
    if port is None:
        port = int(os.environ.get("PORT", "8000"))
    try:
        sock = bind_listening_socket(host, port)
    except OSError as exc:
        print(f"ERROR:    {exc}", file=sys.stderr, flush=True)
        raise SystemExit(STARTUP_FAILURE) from None
    listening_since = time.monotonic()
    try:
        # Imported only now: connections already queue on the socket.
        import uvicorn

        from agent_startup_gate import StartupGate, logger

        gate = StartupGate(load_app, listening_since=listening_since)
        # The API has no WebSocket routes; ws="none" also skips importing the
        # installed websockets package while the server starts.
        config = uvicorn.Config(gate, host=host, port=port, ws="none")
        server = _create_server(uvicorn, config, gate)
        logger.info(
            "Enterprise Agent API listening on http://%s:%d; requests wait "
            "until the application is ready.",
            host,
            port,
        )
        try:
            server.run(sockets=[sock])
        except KeyboardInterrupt:
            pass
    finally:
        sock.close()
    if gate.exit_code is not None:
        raise SystemExit(gate.exit_code)
    if not server.started:
        raise SystemExit(STARTUP_FAILURE)
