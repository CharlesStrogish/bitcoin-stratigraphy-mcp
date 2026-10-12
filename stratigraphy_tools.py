# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Canonical MCP data source: live pipeline plus authoritative cloud archives."""

import base64
import hashlib
import json
from datetime import datetime, timedelta, timezone

from provenance_anchor import ProofNotFound, validate_date
from provenance_storage import validate_snapshot
from stratigraphy_pipeline import ATTRIBUTION


class PrimaryStratigraphy:
    def __init__(self, storage):
        self.storage = storage

    def query(self, tool, arguments, live):
        snapshots, proofs = self.storage.days()
        days = sorted(snapshots)

        if tool == "stratigraphy.list":
            bounds = []
            for day in dict.fromkeys(days[:1] + days[-1:]):
                body = self.storage.get(day)
                if body is None:
                    raise ProofNotFound("Archive changed during catalog discovery")
                validate_snapshot(body)
                bounds.append(json.loads(body)["block_height"])
            return {
                "result": {
                    "totalSnapshots": len(days),
                    "oldestBlock": min(bounds) if bounds else None,
                    "newestBlock": max(bounds) if bounds else None,
                    "liveBlockHeight": live["block_height"],
                    "dateBounds": {
                        "startDate": days[0] if days else None,
                        "endDate": days[-1] if days else None,
                    },
                    "availableMetrics": list(live),
                    "efficiency_baseline_j_th": 15,
                    "attribution": ATTRIBUTION,
                    "proofArchiveCount": len(snapshots & proofs),
                    "source": "stratigraphy_pipeline.py + Replit Object Storage",
                },
                "targetHeights": [],
            }

        # Never derive archive heights from dates or synthetic 144-block indices.
        loaded = {}
        manifests = {}

        def archive(day):
            day = validate_date(day)
            if day not in loaded:
                body, proof, status = self.storage.load(day)
                loaded[day] = json.loads(body)
                filename = f"snapshot_{day}.json"
                manifests[day] = {
                    "date": day,
                    "snapshot_filename": filename,
                    "ots_filename": filename + ".ots",
                    "snapshot_json": body.decode("utf-8"),
                    "snapshot_sha256": hashlib.sha256(body).hexdigest(),
                    "ots_sha256": hashlib.sha256(proof).hexdigest(),
                    "ots_proof_base64": base64.b64encode(proof).decode("ascii"),
                    "proof_status": status,
                    "snapshot_download_url": f"/agent-api/historical-proof/{day}/snapshot",
                    "ots_download_url": f"/agent-api/historical-proof/{day}/ots",
                    "bundle_download_url": f"/agent-api/historical-proof/{day}/download",
                }
            return loaded[day]

        def target(value):
            if value == "latest":
                return live
            if value.isdecimal():
                height = int(value)
                if height == live["block_height"]:
                    return live
                for day in reversed(days):
                    body = self.storage.get(day)
                    if body is None:
                        continue
                    validate_snapshot(body)
                    if json.loads(body)["block_height"] == height:
                        return archive(day)
                raise ProofNotFound("No captured snapshot at this real Bitcoin height")
            return archive(validate_date(value))

        def digest(record, fmt):
            body = next(
                (m["snapshot_json"].encode("utf-8") for day, m in manifests.items()
                 if loaded[day] is record),
                json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode(),
            )
            values = [
                record["block_height"], record["observed_at_utc"],
                record["hal_finney_horizon_multiple"], hashlib.sha256(body).hexdigest(),
            ]
            if fmt == "minimal":
                return values
            if fmt == "kv":
                return dict(zip(("h", "ts", "tm", "hash"), values))
            return f"HEIGHT:{values[0]}|DATE:{values[1]}|TM:{values[2]}|HASH:{values[3]}"

        def position(record):
            return (record["block_height"], record["observed_at_utc"])

        selected = []
        limit = arguments.get("limit", 10)
        if tool == "stratigraphy.get":
            if "date" in arguments:
                selected = [archive(arguments["date"])]
            elif "blockHeight" in arguments:
                selected = [target(str(arguments["blockHeight"]))]
            elif "days" in arguments:
                cutoff = (datetime.now(timezone.utc).date() - timedelta(days=arguments["days"] - 1)).isoformat()
                selected = [archive(day) for day in days if day >= cutoff]
                if live["observed_at_utc"][:10] >= cutoff:
                    selected.append(live)
                selected = selected[-limit:]
            elif any(key in arguments for key in ("startDate", "endDate", "startBlock", "endBlock")):
                for key in ("startDate", "endDate"):
                    if key in arguments:
                        validate_date(arguments[key])
                candidates = [
                    day for day in days
                    if arguments.get("startDate", "0000") <= day <= arguments.get("endDate", "9999")
                ]
                for day in candidates:
                    # Filter actual archived heights without loading out-of-range proofs.
                    body = self.storage.get(day)
                    if body is None:
                        continue
                    validate_snapshot(body)
                    height = json.loads(body)["block_height"]
                    if arguments.get("startBlock", 0) <= height <= arguments.get("endBlock", 2**53):
                        selected.append(archive(day))
                        if len(selected) >= limit:
                            break
            else:
                selected = [live]
            if not selected:
                raise ProofNotFound("No captured snapshots match this query")
            result = {"records": selected}
        elif tool == "stratigraphy.get_digest":
            value = arguments.get("target", "latest")
            fmt = arguments.get("format", "compact")
            if ".." in value:
                start, end = map(validate_date, value.split(".."))
                if start > end:
                    raise ValueError("Reversed date range")
                matches = [day for day in days if start <= day <= end]
                if len(matches) > 100:
                    raise ValueError("Digest range exceeds 100 captured snapshots")
                selected = [archive(day) for day in matches]
                if not selected:
                    raise ProofNotFound("No captured snapshots match this date range")
                value = [digest(record, fmt) for record in selected]
            else:
                selected = [target(value)]
                value = digest(selected[0], fmt)
            result = {"result": value}
        elif tool == "stratigraphy.get_diff":
            before, after = target(arguments["fromTarget"]), target(arguments.get("toTarget", "latest"))
            selected = [before, after]
            difference = after["hal_finney_horizon_multiple"] - before["hal_finney_horizon_multiple"]

            def summary(record):
                return {
                    "height": record["block_height"], "date": record["observed_at_utc"],
                    "target_multiplier": record["hal_finney_horizon_multiple"],
                    "network_energy_watts": record["network_energy_watts"],
                }

            result = {
                "from": summary(before), "to": summary(after),
                "delta": {
                    "heightDelta": after["block_height"] - before["block_height"],
                    "multiplierDelta": difference,
                    "percentageChange": f"{difference / before['hal_finney_horizon_multiple'] * 100:.2f}%",
                    "energyWattsDelta": after["network_energy_watts"] - before["network_energy_watts"],
                    "timeSpanDays": (
                        datetime.fromisoformat(after["observed_at_utc"]) -
                        datetime.fromisoformat(before["observed_at_utc"])
                    ).total_seconds() / 86400,
                },
            }
        elif tool == "stratigraphy.get_range":
            start = target(arguments["startTarget"])
            end = target(arguments.get("endTarget", "latest"))
            if position(start) > position(end):
                raise ValueError("startTarget must not follow endTarget")
            limit = arguments.get("limit", 50)
            for day in days:
                body = self.storage.get(day)
                if body is None:
                    continue
                validate_snapshot(body)
                record = json.loads(body)
                if position(start) <= position(record) <= position(end):
                    selected.append(archive(day))
                    if len(selected) >= limit:
                        break
            if len(selected) < limit and position(start) <= position(live) <= position(end):
                selected.append(live)
            if not selected:
                raise ProofNotFound("No captured snapshots match this range")
            fmt = arguments.get("format", "compact")
            result = {
                "range": {"start": arguments["startTarget"], "end": arguments.get("endTarget", "latest")},
                "count": len(selected), "format": fmt,
                "records": [digest(record, fmt) for record in selected],
            }
        else:
            raise ValueError("Unknown stratigraphy operation")

        # Attach the newest existing archive to live-only queries, without claiming
        # it proves this changing live snapshot or inventing an absent UTC day.
        if days and not manifests:
            archive(days[-1])
        result.update(
            live_metrics=live,
            historical_proofs=list(manifests.values()),
            proofAvailable=bool(manifests),
            archive_state="available" if manifests else "no_archives",
            proof_coverage="Exact archived snapshot_json only; changing live_metrics are not covered.",
        )
        return {
            "result": result,
            # Live metrics and all fetched boundary records are disclosed, so every
            # one must honor delegated max_target caveats, not just truncated rows.
            "targetHeights": list({live["block_height"], *(
                record["block_height"] for record in selected + list(loaded.values())
            )}),
        }
