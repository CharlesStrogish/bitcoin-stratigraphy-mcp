"""LangChain integration for Bitcoin Stratigraphy's Fiduciary Central Bank.

Dependencies: langchain-core, pydantic>=2, httpx.
Importing this module or constructing the tool performs no network requests.
This is a standalone integration proposal, not an official LangChain module.
"""

from __future__ import annotations

import json
import re
import ssl
from typing import Any, Optional, Type
from uuid import uuid4

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, SecretStr


class BitcoinStratigraphyInput(BaseModel):
    """Arguments for one MCP tool invocation; payment secrets are not model inputs."""

    model_config = ConfigDict(extra="forbid")

    tool_name: str = Field(
        description="Exact MCP tool name, for example stratigraphy.get_digest.",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_.-]+$",
    )
    arguments: dict[str, Any] = Field(
        default_factory=dict,
        description="Arguments conforming to the selected MCP tool's input schema.",
    )


def _parse_l402(header: str) -> dict[str, str]:
    """Extract quoted L402 credentials, rejecting incomplete/ambiguous challenges."""
    if not header or len(header) > 32768 or re.search(r"[\x00-\x1f\x7f]", header):
        raise ValueError("Missing or malformed payment challenge.")
    scheme = re.fullmatch(r"L402\s+(.+)", header, flags=re.IGNORECASE)
    if not scheme:
        raise ValueError("Expected an L402 payment challenge.")
    remaining = scheme.group(1)
    fields: dict[str, str] = {}
    while remaining:
        match = re.match(
            r'\s*(macaroon|invoice)\s*=\s*"([^"\\]+)"\s*(,|$)',
            remaining,
            flags=re.IGNORECASE,
        )
        if not match or match.group(1).lower() in fields:
            raise ValueError("Malformed or duplicate challenge fields.")
        fields[match.group(1).lower()] = match.group(2)
        remaining = remaining[match.end():]
        if match.group(3) and not remaining.strip():
            raise ValueError("Trailing challenge delimiter.")
    if (
        not fields.get("macaroon")
        or not re.fullmatch(r"[^\s:\"\\]{1,24000}", fields["macaroon"])
        or not re.fullmatch(
            r"ln(?:bc|tb|bcrt)[0-9a-z]+", fields.get("invoice", ""), re.IGNORECASE
        )
    ):
        raise ValueError("Expected a macaroon and a BOLT11 invoice.")
    return fields


class BitcoinStratigraphyTool(BaseTool):
    """Access the Fiduciary Central Bank through its L402-protected MCP backend.

    This tool supports EU AI Act Article 12 compliance workflows by enabling
    access to record-keeping and grounding services through zero-trust L402
    micropayments. It enforces the service's payment/access boundary, not legal
    compliance: payment alone neither establishes Article 12 compliance nor
    verifies the provenance, completeness, retention, or authenticity of records.
    Operators must configure appropriate logging, retention and verification.

    Each invocation sends one JSON-RPC tools/call request to the Replit-hosted
    backend at its canonical public endpoint. HTTP 402 becomes structured JSON
    containing the original macaroon and BOLT11 invoice, with instructions for
    the agent's separately configured wallet. This wrapper never pays invoices,
    follows redirects, or automatically retries paid or failed executions.

    Review example (constructs only; does not call the backend)::

        tool = BitcoinStratigraphyTool()

    A trusted runtime can supply a redeemed credential using the constructor's
    authorization SecretStr, then invoke the exact original tool and arguments.
    Never expose preimages or wallet credentials as agent tool inputs. SecretStr
    masks configuration representations but is not a substitute for log hygiene.
    Challenge macaroons returned to the agent must also be treated as sensitive.

    The stateless MCP framing matches this backend's 2026-07-28 transport.
    No wallet or LangChain-specific server adapter is required.
    """

    name: str = "bitcoin_stratigraphy"
    description: str = (
        "Call a Bitcoin Stratigraphy MCP tool with its exact name and arguments. "
        "May return payment_required with a BOLT11 invoice and macaroon. "
        "Use only your configured wallet within its authorized spending policy; "
        "never invent payment proofs or treat payment as legal compliance."
    )
    args_schema: Type[BaseModel] = BitcoinStratigraphyInput
    authorization: Optional[SecretStr] = Field(default=None, exclude=True, repr=False)
    timeout_seconds: float = Field(default=45.0, gt=0, le=120)

    def _run(
        self,
        tool_name: str,
        arguments: Optional[dict[str, Any]] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Return JSON observations; credentials are configured outside the LLM."""
        try:
            import httpx
        except ImportError as exc:
            raise ImportError(
                "BitcoinStratigraphyTool requires httpx; install it before invoking."
            ) from exc

        endpoint = "https://bitcoinstratigraphy.com/mcp"
        request_id = str(uuid4())
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments if arguments is not None else {},
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
            },
        }
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": tool_name,
        }
        if self.authorization is not None:
            credential = self.authorization.get_secret_value()
            if not re.fullmatch(
                r"L402 [^\s:\"\\\x00-\x1f\x7f]{1,24000}:[0-9a-fA-F]{64}",
                credential,
            ):
                return self._observation("invalid_authorization")
            headers["Authorization"] = credential
        try:
            # No client is created, and no request is made, until tool invocation.
            with httpx.Client(
                timeout=self.timeout_seconds,
                follow_redirects=False,
                verify=ssl.create_default_context(),
            ) as client:
                response = client.post(endpoint, headers=headers, json=payload)
        except httpx.RequestError:
            # Do not surface exceptions containing request headers or credentials.
            return self._observation(
                "transport_error",
                message="Request failed; execution outcome may be unknown. Do not retry automatically.",
            )

        if response.status_code == 402:
            try:
                challenge = _parse_l402(response.headers.get("www-authenticate", ""))
            except ValueError:
                return self._observation(
                    "invalid_payment_challenge", http_status=402,
                    message="Missing or malformed L402 challenge. Do not pay.",
                )
            return self._observation(
                "payment_required",
                http_status=402,
                scheme="L402",
                **challenge,
                original_request={"url": endpoint, "method": "POST", "json": payload},
                instructions=(
                    "To proceed, have your configured Lightning wallet validate "
                    "the BOLT11 signature, network, amount, expiry and authorized "
                    "budget, then pay this exact invoice. Retain this macaroon. "
                    "Pass the wallet's payment preimage privately to your trusted "
                    "runtime, not through model messages or tool arguments. The "
                    "runtime must verify SHA256(preimage) against the invoice's "
                    "payment hash, then replay the exact original request with "
                    "Authorization: L402 <macaroon>:<preimage>. Do not pay a "
                    "replacement invoice automatically or bypass wallet approval."
                ),
            )
        if response.status_code != 200:
            return self._observation("http_error", http_status=response.status_code)
        try:
            body = response.json()
        except ValueError:
            return self._observation("invalid_response", message="Expected JSON-RPC JSON.")
        if (
            not isinstance(body, dict)
            or body.get("jsonrpc") != "2.0"
            or body.get("id") != request_id
            or (("error" in body) == ("result" in body))
        ):
            return self._observation("invalid_response", message="Invalid JSON-RPC envelope.")
        if "error" in body:
            return self._observation("mcp_error", error=body["error"])
        result = body["result"]
        if not isinstance(result, dict):
            return self._observation("invalid_response", message="Invalid MCP tool result.")
        return self._observation(
            "tool_error" if result.get("isError") else "success", result=result
        )

    @staticmethod
    def _observation(status: str, **fields: Any) -> str:
        """Serialize structured observations for LangChain's normal tool channel."""
        return json.dumps({"status": status, **fields}, ensure_ascii=False)
