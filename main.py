# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import sys
from pathlib import Path

from license_verifier import verify_license


def require_enterprise_license():
    """Deny startup unless the project-root license verifies explicitly True."""
    try:
        license_path = Path(__file__).resolve().with_name("acme_corp.lic")
        authorized = verify_license(license_path)
    except Exception:
        print(
            "ACCESS DENIED: Enterprise license is missing or invalid. "
            "Application startup aborted.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None

    if authorized is not True:
        print(
            "ACCESS DENIED: Enterprise license is expired or invalid. "
            "Application startup aborted.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def start_engine():
    # Import only after authorization; direct ASGI imports are gated separately.
    from agent_api import run_server

    run_server()


def main():
    require_enterprise_license()
    print(
        "Welcome to Bitcoin Stratigraphy Enterprise. "
        "Your license has been verified; starting the engine."
    )
    start_engine()


if __name__ == "__main__":
    main()
