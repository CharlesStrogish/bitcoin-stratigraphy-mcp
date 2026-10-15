# Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
"""Authenticated internal bridge; never an unpaid public MCP execution route."""

import asyncio
import hashlib
import hmac
import json
import os
import time
from collections import OrderedDict

from fastapi import HTTPException, Request

from provenance_anchor import ProofNotFound, ProofUnavailable
from provenance_storage import StorageUnavailable
from stratigraphy_pipeline import PipelineUnavailable
from stratigraphy_tools import PrimaryStratigraphy


def register_stratigraphy_bridge(app, storage, prefix):
    seen = OrderedDict()
    source = PrimaryStratigraphy(storage)

    @app.post(f"{prefix}/internal/stratigraphy", include_in_schema=False)
    async def bridge(request: Request):
        secret = os.environ.get("SESSION_SECRET")
        if not secret:
            raise HTTPException(503, "Internal data bridge is not configured")
        body = bytearray()
        async for part in request.stream():
            body.extend(part)
            if len(body) > 16384:
                raise HTTPException(413, "Internal request exceeds size limit")
        timestamp = request.headers.get("x-stratigraphy-time", "")
        nonce = request.headers.get("x-stratigraphy-nonce", "")
        signature = request.headers.get("x-stratigraphy-signature", "")
        try:
            if abs(time.time() - int(timestamp)) > 30 or len(nonce) != 32:
                raise ValueError("Expired authentication")
            expected = hmac.new(
                secret.encode(), timestamp.encode() + b"\n" + nonce.encode() + b"\n" + body,
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(expected, signature) or nonce in seen:
                raise ValueError("Invalid authentication")
        except ValueError as exc:
            raise HTTPException(401, "Invalid internal bridge authentication") from exc
        now = time.monotonic()
        while seen and next(iter(seen.values())) < now - 60:
            seen.popitem(last=False)
        if len(seen) >= 10000:
            raise HTTPException(503, "Internal request authentication capacity exceeded")
        seen[nonce] = now
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get("arguments"), dict):
                raise ValueError("Invalid internal query")
            pipeline = app.state.stratigraphy_pipeline
            await pipeline.wait_for_first_refresh()
            live = pipeline.get_snapshot().model_dump()
            return await asyncio.to_thread(source.query, data["tool"], data["arguments"], live)
        except PipelineUnavailable as exc:
            raise HTTPException(503, "Live stratigraphy pipeline unavailable") from exc
        except StorageUnavailable as exc:
            raise HTTPException(503, "Historical archive storage unavailable") from exc
        except ProofNotFound as exc:
            raise HTTPException(404, str(exc)) from exc
        except ProofUnavailable as exc:
            raise HTTPException(409, str(exc)) from exc
        except (ValueError, KeyError, TypeError) as exc:
            raise HTTPException(422, "Invalid stratigraphy query") from exc
