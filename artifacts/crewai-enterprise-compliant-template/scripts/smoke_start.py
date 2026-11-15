"""Verify the real two-process demo launcher using a disposable local port."""

import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1]
with socket.socket() as reservation:
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]
url = f"http://127.0.0.1:{port}"
with tempfile.TemporaryFile(mode="w+") as log:
    process = subprocess.Popen(
        ["node", "scripts/start.mjs"], cwd=root,
        env={
            **os.environ, "SWARM_MODE": "demo", "PYTHON": sys.executable,
            "VIEWER_PORT": str(port),
        },
        stdout=log, stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            log.seek(0)
            output = log.read()
            if "Swarm stopped (exit 1)" in output:
                break
            if process.poll() is not None:
                raise AssertionError("Launcher exited before the demo halt:\n" + output)
            time.sleep(0.1)
        else:
            raise AssertionError("Demo did not finish within its bounded timeout.")
        assert "LOCAL MOCK SLACK PAYLOAD" in output
        assert "Swarm Halted: EU AI Act Compliance Lock" in output
        assert "Traceback" not in output
        with urlopen(url + "/local-api/status", timeout=2) as response:
            status = json.load(response)
        assert status["configured"] is False and status["status"] == "missing"
        with urlopen(url, timeout=2) as response:
            html = response.read().decode()
        asset = re.search(r'src="([^"]+\.js)"', html).group(1)
        with urlopen(url + asset, timeout=2) as response:
            assert response.status == 200 and len(response.read()) > 1000
        try:
            urlopen(url + "/.env", timeout=2)
        except HTTPError as error:
            assert error.code == 404
            error.close()
        else:
            raise AssertionError("Private .env path was exposed.")
        print("PASS: dashboard + swarm launched; mock alert delivered; halted worker stayed stopped; dashboard remained available.")
    finally:
        process.terminate()
        try:
            process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
    try:
        urlopen(url, timeout=1)
    except (URLError, TimeoutError):
        print("PASS: launcher shutdown also closed the dashboard process.")
    else:
        raise AssertionError("Dashboard was orphaned after supervisor shutdown.")
