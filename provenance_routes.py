# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""JSON-friendly MCP proof delivery plus byte-exact REST file downloads."""

import asyncio
import base64
import hashlib
import io
import zipfile
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from provenance_anchor import ProofNotFound, ProofUnavailable
from provenance_storage import StorageUnavailable


class HistoricalProof(BaseModel):
    date: str
    snapshot_filename: str
    ots_filename: str
    snapshot_sha256: str
    ots_sha256: str
    snapshot_json: str
    ots_proof_base64: str
    proof_status: Literal["pending_bitcoin_confirmation", "bitcoin_attestation_present_unverified"]
    snapshot_download_url: str
    ots_download_url: str
    bundle_download_url: str
    verification_instructions: str


def register_provenance_routes(app: FastAPI, storage, prefix: str):
    async def load(day):
        try:
            return await asyncio.to_thread(storage.load, day)
        except ValueError as exc:
            raise HTTPException(422, "date must be a real UTC calendar date in YYYY-MM-DD format") from exc
        except ProofNotFound as exc:
            raise HTTPException(404, "No archived snapshot for this UTC date") from exc
        except ProofUnavailable as exc:
            raise HTTPException(409, str(exc)) from exc
        except StorageUnavailable as exc:
            raise HTTPException(503, "Historical archive storage is temporarily unavailable") from exc

    @app.get(
        f"{prefix}/historical-proof",
        operation_id="get_historical_proof",
        response_model=HistoricalProof,
        summary="Download a UTC-dated snapshot and its OpenTimestamps proof",
        description=(
            "Return the exact archived JSON text, base64-encoded .ots bytes, SHA-256 digests "
            "and REST download URLs for YYYY-MM-DD. A pending calendar receipt is not yet "
            "Bitcoin-confirmed. Upgrade and independently verify with OpenTimestamps "
            "and your own Bitcoin node. This operation is read-only and does not backfill dates."
        ),
    )
    async def get_historical_proof(
        date: Annotated[str, Query(pattern=r"^\d{4}-\d{2}-\d{2}$", description="UTC archive date, YYYY-MM-DD")],
    ) -> HistoricalProof:
        snapshot, proof, status = await load(date)
        filename = f"snapshot_{date}.json"
        base = f"{prefix}/historical-proof/{date}"
        return HistoricalProof(
            date=date,
            snapshot_filename=filename,
            ots_filename=filename + ".ots",
            snapshot_sha256=hashlib.sha256(snapshot).hexdigest(),
            ots_sha256=hashlib.sha256(proof).hexdigest(),
            snapshot_json=snapshot.decode("utf-8"),
            ots_proof_base64=base64.b64encode(proof).decode("ascii"),
            proof_status=status,
            snapshot_download_url=base + "/snapshot",
            ots_download_url=base + "/ots",
            bundle_download_url=base + "/download",
            verification_instructions=(
                f"Save snapshot_json verbatim as UTF-8 to {filename}; base64-decode "
                f"ots_proof_base64 to {filename}.ots, or use the download URLs. "
                f"On an independent OpenTimestamps client: ots upgrade {filename}.ots; "
                f"ots verify {filename}.ots. Verify against your own fully validating "
                "Bitcoin mainnet node. SHA-256 and calendar acceptance alone do not "
                "prove Bitcoin inclusion, data accuracy, or an exact midnight timestamp."
            ),
        )

    @app.get(f"{prefix}/historical-proof/{{date}}/{{file}}", include_in_schema=False)
    async def download(date: str, file: Literal["snapshot", "ots", "download"]):
        snapshot, proof, _ = await load(date)
        filename = f"snapshot_{date}.json"
        if file == "snapshot":
            body, name, mime = snapshot, filename, "application/json"
        elif file == "ots":
            body, name, mime = proof, filename + ".ots", "application/octet-stream"
        else:
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
                bundle.writestr(filename, snapshot)
                bundle.writestr(filename + ".ots", proof)
            body, name, mime = archive.getvalue(), f"snapshot_{date}.zip", "application/zip"
        return Response(
            body, media_type=mime,
            headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
        )
