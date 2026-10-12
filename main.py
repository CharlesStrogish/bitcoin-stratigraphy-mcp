# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import sys
from pathlib import Path

from license_verifier import verify_license


def main():
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

    print(
        "Welcome to Bitcoin Stratigraphy Enterprise. "
        "Your license has been verified; starting the engine."
    )
    print("Hello from repl-nix-workspace!")


if __name__ == "__main__":
    main()
