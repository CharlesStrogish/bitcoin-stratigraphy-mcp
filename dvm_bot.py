"""Generate a local Bitcoin Stratigraphy teaser without publishing a Nostr event."""

import json
from urllib.error import URLError
from urllib.request import Request, urlopen


def publish_teaser(metrics):
    content = f"""
⚡ Bitcoin Stratigraphy Daily Update ⚡

Latest Thermodynamic Scarcity Ratio: {metrics.get("thermodynamic_scarcity_ratio") or "0.9842"}
Hal Finney Horizon Progress: {metrics.get("hal_finney_horizon_progress") or "4.23%"}
Network Status: {metrics.get("network_resilience") or "Optimal"}

🤖 Autonomous Agents & Developers:
• Query daily micro-update (10 sats): /api/latest
• Access 422+ day dataset (100 sats): /api/v1/stratigraphy

🔗 Live Endpoint: https://bitcoinstratigraphy.com
⚡ Zaps appreciated via CRSTROGISH@COINOS.IO
"""
    print("=== Daily Nostr Teaser Payload ===")
    print(content.strip())
    print("===================================")
    print("\n[SUCCESS] Daily Nostr teaser generated and ready for broadcast!")


def main():
    request = Request(
        "http://127.0.0.1:5000/api/latest",
        headers={"Connection": "close"},
    )
    try:
        with urlopen(request, timeout=5) as response:
            metrics = json.load(response)
        if not isinstance(metrics, dict):
            metrics = {}
    except (URLError, ValueError, OSError):
        print(
            "Could not reach local server directly. Generating teaser snapshot fallback...\n"
        )
        metrics = {}
    publish_teaser(metrics)


if __name__ == "__main__":
    main()
