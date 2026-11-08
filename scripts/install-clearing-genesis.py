"""Install the immutable public Genesis proving key, never generate or rotate it."""
import hashlib
import os
import pathlib
import sys

SHA256 = "ad2c722746c675e7c563d7ad767fdd7b47cbffa026abafad2ebfaa4300d6f630"
OBJECT_NAME = f"clearing-genesis/{SHA256}/circuit_final.zkey"
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "generated-artifacts/solo-founder-genesis/circuit_final.zkey"


def checked(data: bytes) -> bytes:
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError("Genesis proving key checksum mismatch; refusing installation")
    return data


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: install-clearing-genesis.py <destination> [...]")
    if CACHE.exists():
        data = checked(CACHE.read_bytes())
    else:
        from replit.object_storage import Client

        data = checked(Client(bucket_id=os.environ["DEFAULT_OBJECT_STORAGE_BUCKET_ID"])
                       .download_as_bytes(OBJECT_NAME))
    for name in sys.argv[1:]:
        destination = pathlib.Path(name)
        destination.mkdir(parents=True, exist_ok=True)
        output = destination / "circuit_final.zkey"
        temporary = output.with_suffix(".zkey.tmp")
        temporary.write_bytes(data)
        temporary.replace(output)
    print(f"Genesis proving key installed and SHA-256 verified: {SHA256}")


if __name__ == "__main__":
    main()
