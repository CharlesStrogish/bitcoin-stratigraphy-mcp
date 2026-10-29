# Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
# Dual-licensed under AGPLv3 and Commercial terms.
"""Optional native CrewAI tools backed by the existing paid MCP transport."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from collections.abc import Callable
from contextlib import ExitStack
from copy import deepcopy
from functools import partial
from datetime import timedelta
from types import TracebackType
from typing import Any, ClassVar

import anyio
import httpx
from anyio.from_thread import BlockingPortal, start_blocking_portal
from mcp import ClientSession
from mcp.shared.exceptions import McpError
from mcp.types import CallToolResult, Tool
from pydantic import (
    BaseModel,
    ConfigDict,
    PrivateAttr,
    model_validator,
)
from pydantic.json_schema import JsonSchemaValue

try:
    from crewai.tools import BaseTool
except ImportError as exc:
    raise ImportError(
        "Native CrewAI tools require bitcoin-stratigraphy-mcp-client[crewai]"
    ) from exc

from jsonschema import Draft202012Validator, ValidationError as SchemaValidationError  # type: ignore[import-untyped]

from .transport import DEFAULT_MCP_URL, L402Nip98Transport, WalletHandler


class CrewAIToolError(RuntimeError):
    """An MCP tool returned isError; do not present it as successful execution."""


def _reject_external_refs(value: object) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("$ref", "$dynamicRef") and (
                not isinstance(child, str) or not child.startswith("#")
            ):
                raise ValueError(
                    "MCP input schemas must use local JSON Schema references"
                )
            _reject_external_refs(child)
    elif isinstance(value, list):
        for child in value:
            _reject_external_refs(child)


class _MCPArguments(BaseModel):
    """Preserve arbitrary MCP JSON Schema without inventing a lossy field map."""

    model_config = ConfigDict(extra="allow")
    _mcp_schema: ClassVar[dict[str, Any]] = {}

    @model_validator(mode="before")
    @classmethod
    def _validate_arguments(cls, value: Any) -> Any:
        try:
            Draft202012Validator(cls._mcp_schema).validate(value)
        except SchemaValidationError as exc:
            # Pydantic expects ValueError; do not silently coerce invalid input.
            raise ValueError(f"Invalid MCP tool arguments: {exc}") from exc
        return value

    @classmethod
    def model_json_schema(cls, *args: Any, **kwargs: Any) -> JsonSchemaValue:
        # The upstream MCP schema already owns its $defs. Do not send its local
        # references through Pydantic's unrelated definition-name registry.
        return deepcopy(cls._mcp_schema)


def _never_cache(arguments: object = None, result: object = None) -> bool:
    # Paid tool results must not bypass billing, freshness or downstream effects.
    return False


class CrewAIMCPTool(BaseTool):
    """A real CrewAI BaseTool; both sync and async calls share one MCP session."""

    _invoke: Callable[[dict[str, Any]], str] = PrivateAttr()

    def __init__(
        self, definition: Tool, invoke: Callable[[dict[str, Any]], str]
    ) -> None:
        schema = deepcopy(definition.inputSchema)
        _reject_external_refs(schema)
        Draft202012Validator.check_schema(schema)
        if schema.get("type") != "object":
            raise ValueError("CrewAI MCP tools require an object input schema")
        name = re.sub(r"[^a-zA-Z0-9_-]", "_", definition.name)
        if not name:
            raise ValueError("MCP tool name cannot be empty")
        if len(name) > 64:
            name = (
                name[:47]
                + "_"
                + hashlib.sha256(definition.name.encode()).hexdigest()[:16]
            )
        args_schema = type(
            f"{name}Arguments", (_MCPArguments,), {"_mcp_schema": schema}
        )
        super().__init__(
            name=name,
            description=definition.description or f"Call MCP tool {definition.name}",
            args_schema=args_schema,
            cache_function=_never_cache,
        )
        self._invoke = invoke

    def _generate_description(self) -> None:
        # CrewAI's default formatter inspects model_fields, which cannot express
        # every JSON Schema. Publish the exact schema instead of claiming {}.
        self.description = f"{self.description}\nMCP input JSON Schema: " + json.dumps(
            self.args_schema.model_json_schema(), ensure_ascii=False
        )

    def _run(self, *args: Any, **kwargs: Any) -> str:
        if args:
            raise ValueError("MCP tools accept named arguments only")
        validated = self.args_schema.model_validate(kwargs)
        return self._invoke(validated.model_dump())

    async def _arun(self, *args: Any, **kwargs: Any) -> str:
        # CrewAI 1.x may invoke sync tools in worker threads or offer _arun.
        # Neither path moves an AnyIO/MCP session onto another event loop.
        return await anyio.to_thread.run_sync(partial(self._run, *args, **kwargs))


class _CrewAITransport(L402Nip98Transport):
    """Deliver local wallet failures to the correct pending MCP request.

    Official MCP sends requests in background tasks. Raising out of HTTPX there
    can leave a separately threaded caller waiting indefinitely. A local-only
    JSON-RPC error wakes that caller, which re-raises the original exception.
    Nothing is transmitted to the server and no extra payment attempt is made.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.failures: dict[str, Exception] = {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return await super().handle_async_request(request)
        except Exception as exc:
            try:
                message = json.loads(await request.aread())
            except (ValueError, UnicodeDecodeError):
                raise exc from None
            if (
                request.method != "POST"
                or not isinstance(message, dict)
                or "id" not in message
            ):
                raise
            token = secrets.token_hex(16)
            if len(self.failures) >= 128:
                self.failures.pop(next(iter(self.failures)))
            self.failures[token] = exc
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {
                        "code": -32098,
                        "message": "Local client transport failure",
                        "data": {"client_transport_failure": token},
                    },
                },
            )

    async def aclose(self) -> None:
        self.failures.clear()
        await super().aclose()


class CrewAISwarmTools:
    """Own one background-loop MCP session for an entire synchronous CrewAI run.

    Enter before constructing agents and keep the context open through kickoff.
    Native sync and async CrewAI invocations submit work to this same loop, so
    NIP-98, L402 payment coordination and MCP session lifetime remain unchanged.
    """

    def __init__(
        self,
        private_key: str,
        wallet_handler: WalletHandler,
        *,
        endpoint: str = DEFAULT_MCP_URL,
        wallet_timeout: float = 120.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._transport = _CrewAITransport(
            private_key,
            wallet_handler,
            endpoint=endpoint,
            wallet_timeout=wallet_timeout,
            transport=transport,
        )
        self._stack: ExitStack | None = None
        self._portal: BlockingPortal | None = None
        self._session: ClientSession | None = None
        self._used = False

    async def _discover(self, session: ClientSession) -> list[Tool]:
        definitions: list[Tool] = []
        seen: set[str] = set()
        cursor: str | None = None
        for _ in range(100):
            page = await session.list_tools(cursor=cursor)
            definitions.extend(page.tools)
            cursor = page.nextCursor
            if not cursor:
                return definitions
            if cursor in seen:
                raise ValueError("MCP tool discovery repeated a pagination cursor")
            seen.add(cursor)
        raise ValueError("MCP tool discovery exceeded 100 pages")

    async def _call(
        self, session: ClientSession, name: str, arguments: dict[str, Any]
    ) -> str:
        try:
            result: CallToolResult = await session.call_tool(
                name, arguments, read_timeout_seconds=timedelta(seconds=300)
            )
        except McpError as exc:
            details = exc.error.data
            if isinstance(details, dict):
                token = details.get("client_transport_failure")
                failure = (
                    self._transport.failures.pop(token, None)
                    if isinstance(token, str)
                    else None
                )
                if failure is not None:
                    raise failure from None
            raise
        if result.isError:
            raise CrewAIToolError(f"MCP tool {name} reported an execution error")
        return result.model_dump_json(by_alias=True, exclude_none=True)

    def _invoke(self, name: str, arguments: dict[str, Any]) -> str:
        portal, session = self._portal, self._session
        if portal is None or session is None:
            raise RuntimeError("CrewAI tool used outside its active swarm context")
        result: object = portal.call(self._call, session, name, arguments)
        if not isinstance(result, str):
            raise TypeError("MCP tool bridge returned a non-text result")
        return result

    def __enter__(self) -> list[CrewAIMCPTool]:
        if self._used:
            raise RuntimeError(
                "Construct a new CrewAISwarmTools for each swarm context"
            )
        self._used = True
        with ExitStack() as stack:
            portal = stack.enter_context(start_blocking_portal())
            session = stack.enter_context(
                portal.wrap_async_context_manager(self._transport.session())
            )
            definitions = portal.call(self._discover, session)
            tools = [
                CrewAIMCPTool(definition, partial(self._invoke, definition.name))
                for definition in definitions
            ]
            if len({tool.name for tool in tools}) != len(tools):
                raise ValueError("MCP tool names collide after CrewAI normalization")
            self._portal, self._session = portal, session
            self._stack = stack.pop_all()
            return tools

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        self._portal, self._session = None, None
        stack, self._stack = self._stack, None
        if stack is None:
            return False
        return bool(stack.__exit__(exc_type, exc_value, traceback))
