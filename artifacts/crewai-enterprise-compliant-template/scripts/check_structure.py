"""Offline distribution checks, runnable without installed third-party packages."""

import ast
import json
from pathlib import Path
import tomllib

root = Path(__file__).resolve().parents[1]
required = [
    "swarm.py", "demo_services.py", "pyproject.toml", "uv.lock", "requirements.lock",
    "requirements-audit.txt", "scripts/smoke_start.py", "scripts/export_requirements.py",
    "package.json", ".env.example", ".gitignore", "LICENSE.md", "README.md",
    "scripts/start.mjs", "scripts/setup.mjs", "tests/test_swarm.py",
    ".github/workflows/ci.yml",
    "dashboard/package.json", "dashboard/pnpm-lock.yaml", "dashboard/pnpm-workspace.yaml",
    "dashboard/server.mjs", "dashboard/server/connection.mjs", "dashboard/src/App.tsx",
    "dashboard/vite.config.ts", "dashboard/index.html", "dashboard/tsconfig.json",
    "packages/l402-interceptor/pyproject.toml",
    "packages/l402-interceptor/src/l402_interceptor/interceptor.py",
]
missing = [name for name in required if not (root / name).is_file()]
assert not missing, f"Missing required template files: {missing}"
project = tomllib.loads((root / "pyproject.toml").read_text())
assert project["tool"]["uv"]["sources"]["l402-interceptor"]["path"] == "packages/l402-interceptor"
for package_file in (root / "package.json", root / "dashboard/package.json"):
    package = json.loads(package_file.read_text())
    for section in ("dependencies", "devDependencies"):
        assert not any(value.startswith(("workspace:", "file:../", "link:../"))
                       for value in package.get(section, {}).values())
assert ".env" in (root / ".gitignore").read_text().splitlines()
for line in (root / "requirements.lock").read_text().splitlines():
    if line.startswith("./"):
        assert ".." not in Path(line).parts and (root / line).is_dir()
for name in ("swarm.py", "demo_services.py"):
    ast.parse((root / name).read_text())
print("PASS: standalone structure, local interceptor mapping, Python syntax and secret-file isolation.")
