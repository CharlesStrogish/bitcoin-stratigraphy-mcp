"""Run after uv lock: export install and registry-only audit requirements."""

from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
subprocess.run(
    ["uv", "export", "--frozen", "--no-dev", "--no-hashes",
     "--no-emit-project", "-o", "requirements.lock"],
    cwd=root, check=True, stdout=subprocess.DEVNULL,
)
lines = (root / "requirements.lock").read_text().splitlines()
(root / "requirements-audit.txt").write_text(
    "# Registry packages from requirements.lock; local interceptor audited as source.\n"
    + "\n".join(line for line in lines if "==" in line and not line.lstrip().startswith("#"))
    + "\n",
)
