"""Run with python -m examples.free_sandbox from the repository root."""
import json
from sdk.python.client import BitcoinStratigraphyClient

if __name__ == "__main__":
    client = BitcoinStratigraphyClient()
    for name in ("stratigraphy.list", "proof.list"):
        print(json.dumps({name: client.call_tool(name, {})}, indent=2))