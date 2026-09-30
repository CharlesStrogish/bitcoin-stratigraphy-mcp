# LangChain and CrewAI with Bitcoin Stratigraphy MCP

This guide connects a Python project to the public Bitcoin Stratigraphy MCP
server at [`https://bitcoin-stratigraphy-dashboard.replit.app/mcp`](https://bitcoin-stratigraphy-dashboard.replit.app/mcp)
using the official Python MCP SDK's `ClientSession` and Streamable HTTP
transport. The wrappers below discover tools at runtime, use each tool's
published `inputSchema` for validation, and preserve the canonical MCP tool
name when making a call.

The examples are **free discovery demonstrations**: they only call
`stratigraphy.list` and `payment.get_info`. They do not request or make paid
calls, access wallet credentials, or settle invoices. The endpoint's advertised
prices may change; check `payment.get_info` at runtime before designing any
paid workflow.

## Tool catalog

The following catalog is transcribed from [`CONNECT.md`](../CONNECT.md). Its
prices are advertised sats from the server documentation, not a price
guarantee; the live `payment.get_info` response is authoritative. The
published MCP catalog currently contains 14 canonical tools.

| Canonical MCP tool | Advertised sats | Use |
| --- | ---: | --- |
| `stratigraphy.get` | 250 | Full indexed daily telemetry (date, indexed height, or bounded selection); not a block-hash lookup. |
| `stratigraphy.get_digest` | 250 | Token-optimized telemetry summary. |
| `stratigraphy.get_diff` | 250 | Differences between indexed strata. |
| `stratigraphy.get_range` | 250 | Compressed records across a bounded sequence. |
| `stratigraphy.list` | 0 | Discover dataset bounds and metrics. |
| `proof.attenuate` | 0 | Narrow an existing valid macaroon; does not pay an invoice. |
| `proof.verify` | 250 | Validate an existing Groth16 proof by default, or verify a complete OTS receipt and Bitcoin attestation with the documented OTS arguments. |
| `proof.get_by_hash` | 250 | Look up a retained proof or signed receipt. |
| `proof.list` | 10 | List indexed proof attestations. |
| `proof.submit` | 250 | Register a submitted proof and attempt an attestation; changes state. |
| `proof.ground` | 250 | Issue a signed Bitcoin-tip context/dataset receipt. |
| `payment.get_info` | 0 | Query prices or verify/settle payment with the required HTTP authentication; this is not an invoice issuer. |
| `mesh.get_status` | 0 | Read peer and quorum health. |
| `mesh.broadcast` | 250 | Sign and distribute a stored snapshot to mesh peers; has side effects. |

Do not hard-code any input signatures from this table. The MCP server's live
`tools/list` response is the source of truth for names, descriptions, and
schemas. The wrappers below derive **all 14** schemas from that response,
including tools whose use is paid or side-effecting. For an agent, only expose
the tools it is authorized to use.

## Install in your own Python project

Use Python **3.11 or newer** for the `asyncio.timeout` examples below.

Use a project virtual environment; these commands are for the consuming
developer project, not for this repository's workspace:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install mcp jsonschema langchain-core crewai
```

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1`. Install
only the framework(s) you need: the basic MCP client and schema validation
need `mcp` and `jsonschema`; LangChain wrappers additionally need
`langchain-core`; CrewAI wrappers additionally need `crewai`. Use your
project's normal lockfile/version policy when pinning package versions.

## Shared MCP client and dynamic schema validation

Keep the transport and session open for the entire period in which framework
tools can execute. `open_mcp()` below is an async context manager: never build
tools around a session and then close it before invoking those tools. It
initializes the session, discovers all current tools, checks every advertised
input schema, and validates arguments immediately before a tool call. A
returned MCP result with `isError` set becomes an explicit exception rather
than a successful-looking tool response.

Save the following as `stratigraphy_mcp.py` in your own project, or copy it
into the framework example modules below.

```python
import asyncio
import json
import re
from contextlib import asynccontextmanager
from typing import Any

from jsonschema import FormatChecker
from jsonschema.validators import validator_for
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import BaseModel, ConfigDict, Field, create_model, model_validator

ENDPOINT = "https://bitcoin-stratigraphy-dashboard.replit.app/mcp"
REQUEST_TIMEOUT_SECONDS = 30


@asynccontextmanager
async def open_mcp():
    """Yield an initialized MCP session; callers own its full lifetime."""
    async with streamable_http_client(ENDPOINT) as (read_stream, write_stream, _):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            yield session


def make_args_model(tool: Any) -> type[BaseModel]:
    """Build a Pydantic model that validates against the server's full schema."""
    schema = tool.inputSchema
    if not isinstance(schema, dict):
        raise TypeError(f"{tool.name} did not advertise an object inputSchema")

    schema_validator = validator_for(schema)
    schema_validator.check_schema(schema)
    json_validator = schema_validator(schema, format_checker=FormatChecker())
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        raise TypeError(f"{tool.name} inputSchema properties must be an object")

    required = set(schema.get("required", []))
    fields: dict[str, tuple[Any, Any]] = {}
    for property_name, property_schema in properties.items():
        if not property_name.isidentifier():
            raise ValueError(
                f"{tool.name} has a property name not supported by the "
                f"framework model: {property_name!r}"
            )
        description = (
            property_schema.get("description", "")
            if isinstance(property_schema, dict)
            else ""
        )
        default = ... if property_name in required else None
        fields[property_name] = (
            Any,
            Field(default, description=description or None),
        )

    def validate_complete_schema(cls: type[BaseModel], values: Any) -> Any:
        errors = sorted(
            json_validator.iter_errors(values),
            key=lambda error: tuple(str(part) for part in error.absolute_path),
        )
        if errors:
            details = "; ".join(error.message for error in errors)
            raise ValueError(f"Invalid arguments for {tool.name}: {details}")
        return values

    extra_policy = "forbid" if schema.get("additionalProperties") is False else "allow"
    # Preserve the full advertised schema for the LLM, including nested
    # properties, enums, and oneOf branches, rather than exposing Any fields.
    def expose_mcp_schema(generated_schema: dict[str, Any]) -> None:
        generated_schema.update(schema)

    model_config = ConfigDict(
        extra=extra_policy,
        json_schema_extra=expose_mcp_schema,
    )
    validators = {
        "validate_complete_mcp_schema": model_validator(mode="before")(
            validate_complete_schema
        )
    }
    model_name = "MCP_" + re.sub(r"[^A-Za-z0-9_]", "_", tool.name) + "_Input"
    return create_model(
        model_name,
        __config__=model_config,
        __validators__=validators,
        **fields,
    )


def framework_name(canonical_name: str) -> str:
    """Return a framework-safe label; calls still use the canonical name."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", canonical_name)


def check_framework_names(tools: list[Any]) -> None:
    """Fail rather than silently merge names after punctuation sanitization."""
    names: dict[str, str] = {}
    for tool in tools:
        safe_name = framework_name(tool.name)
        previous = names.get(safe_name)
        if previous is not None and previous != tool.name:
            raise ValueError(
                f"Framework name collision: {previous!r} and {tool.name!r} "
                f"both map to {safe_name!r}"
            )
        names[safe_name] = tool.name


async def discover_tools(session: ClientSession) -> list[Any]:
    """List tools at runtime and validate every advertised input schema."""
    response = await session.list_tools()
    tools = list(response.tools)
    check_framework_names(tools)
    for tool in tools:
        make_args_model(tool)
    return tools


def result_text(result: Any) -> str:
    """Convert a successful MCP result to framework-friendly text."""
    if result.isError:
        messages = [
            block.text
            for block in (result.content or [])
            if getattr(block, "text", None)
        ]
        detail = "\n".join(messages) or "The server returned an MCP tool error."
        raise RuntimeError(detail)

    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return json.dumps(structured, ensure_ascii=False, default=str)

    text_blocks = [
        block.text
        for block in (result.content or [])
        if getattr(block, "text", None)
    ]
    if text_blocks:
        return "\n".join(text_blocks)
    return json.dumps(result.model_dump(mode="json"), ensure_ascii=False, default=str)


async def call_mcp(
    session: ClientSession,
    canonical_name: str,
    arguments: dict[str, Any],
) -> str:
    """Validate inputs, call by canonical name, and surface MCP tool errors."""
    response = await session.list_tools()
    tool = next((item for item in response.tools if item.name == canonical_name), None)
    if tool is None:
        raise KeyError(f"Server did not advertise MCP tool {canonical_name!r}")

    args_model = make_args_model(tool)
    validated = args_model.model_validate(arguments).model_dump(
        mode="json", exclude_unset=True
    )
    async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
        result = await session.call_tool(canonical_name, arguments=validated)
    return result_text(result)
```

`jsonschema` enforces the complete advertised JSON Schema, including nested
objects, enums, bounds, patterns, and `additionalProperties`; the generated
Pydantic fields expose the arguments to framework schema inspection. The
schema is re-read from the live session for each invocation so framework
wrappers do not invent or freeze MCP argument signatures.

## LangChain async tools

`StructuredTool.from_function` accepts an async `coroutine` and an explicit
`args_schema`. Create one wrapper from each discovered MCP tool. The original
canonical name is closed over for the MCP call; only the framework-facing
name is sanitized (`stratigraphy.get_digest` becomes `stratigraphy_get_digest`).
The `tool_by_mcp_name` mapping retains the canonical-to-framework association.

The executable example deliberately invokes only the two free discovery
tools. It is safe to use from an existing async application because it does
not call `asyncio.run()`.

```python
from typing import Any

from langchain_core.tools import StructuredTool
from mcp import ClientSession

from stratigraphy_mcp import (
    call_mcp,
    discover_tools,
    framework_name,
    make_args_model,
    open_mcp,
)


async def build_langchain_tools(
    session: ClientSession,
) -> tuple[list[StructuredTool], dict[str, StructuredTool]]:
    discovered = await discover_tools(session)
    framework_tools: list[StructuredTool] = []
    tool_by_mcp_name: dict[str, StructuredTool] = {}

    for metadata in discovered:
        canonical_name = metadata.name
        args_model = make_args_model(metadata)

        def make_invoker(bound_name: str):
            async def invoke_mcp_tool(**arguments: Any) -> str:
                return await call_mcp(session, bound_name, arguments)

            return invoke_mcp_tool

        wrapped = StructuredTool.from_function(
            coroutine=make_invoker(canonical_name),
            name=framework_name(canonical_name),
            description=metadata.description or canonical_name,
            args_schema=args_model,
            infer_schema=False,
        )
        framework_tools.append(wrapped)
        tool_by_mcp_name[canonical_name] = wrapped

    return framework_tools, tool_by_mcp_name


async def langchain_discovery_demo() -> None:
    async with open_mcp() as session:
        tools, tool_by_mcp_name = await build_langchain_tools(session)
        print(f"Discovered {len(tools)} MCP tools.")

        # These names are selected from the current CONNECT.md free-discovery
        # catalog. The inputs are validated against each live inputSchema.
        catalog = await tool_by_mcp_name["stratigraphy.list"].ainvoke({})
        prices = await tool_by_mcp_name["payment.get_info"].ainvoke({})
        print("Dataset catalog:", catalog)
        print("Current advertised pricing:", prices)


if __name__ == "__main__":
    import asyncio

    asyncio.run(langchain_discovery_demo())
```

The example above is runnable as a script. In a notebook, web server, or
application that already has an event loop, call `await
langchain_discovery_demo()` from its async entry point instead; do **not**
call `asyncio.run()` there. For agent execution, provide the returned
`framework_tools` to the LangChain agent/executor and use that framework's
async invocation method while `open_mcp()` remains active. Limit the supplied
tool set to the operations that the agent is allowed to perform.

## CrewAI `BaseTool` wrappers and `kickoff_async`

CrewAI's documented `kickoff_async()` runs synchronous `kickoff()` work in a
thread. A normal synchronous `_run()` must therefore not directly call the
async MCP session from that worker thread. This example keeps the MCP session
on its owning async event loop for the complete crew run, and uses
`asyncio.run_coroutine_threadsafe()` to schedule each MCP request back onto
that owning loop. It does not create a second event loop or call
`asyncio.run()` inside a framework tool.

The runnable CrewAI example exposes only the two catalog discovery tools, and
the prompt explicitly asks for free catalog/pricing discovery. The `BaseTool`
factory nevertheless builds schema-backed wrappers dynamically for every
tool returned by `tools/list`; do not add paid or side-effecting tools unless
you also build and enforce an appropriate authorization and payment path.

```python
import asyncio
from typing import Any

from crewai import Agent, Crew, Task
from crewai.tools import BaseTool
from mcp import ClientSession
from pydantic import BaseModel

from stratigraphy_mcp import (
    REQUEST_TIMEOUT_SECONDS,
    call_mcp,
    discover_tools,
    framework_name,
    make_args_model,
    open_mcp,
)


def make_crewai_tool(
    metadata: Any,
    args_model: type[BaseModel],
    session: ClientSession,
    owner_loop: asyncio.AbstractEventLoop,
) -> BaseTool:
    canonical_name = metadata.name

    def run_in_owner_loop(self: BaseTool, **arguments: Any) -> str:
        if owner_loop.is_closed():
            raise RuntimeError("The MCP session's owning event loop is closed")
        future = asyncio.run_coroutine_threadsafe(
            call_mcp(session, canonical_name, arguments),
            owner_loop,
        )
        try:
            return future.result(timeout=REQUEST_TIMEOUT_SECONDS + 5)
        except TimeoutError:
            future.cancel()
            raise TimeoutError(
                f"MCP tool {canonical_name!r} exceeded its execution timeout"
            ) from None

    class_name = "CrewMCP_" + framework_name(canonical_name).title().replace("_", "")
    return type(
        class_name,
        (BaseTool,),
        {
            "__annotations__": {
                "name": str,
                "description": str,
                "args_schema": type[BaseModel],
            },
            "name": framework_name(canonical_name),
            "description": metadata.description or canonical_name,
            "args_schema": args_model,
            "_run": run_in_owner_loop,
        },
    )()


async def build_crewai_tools(
    session: ClientSession,
    owner_loop: asyncio.AbstractEventLoop,
) -> dict[str, BaseTool]:
    discovered = await discover_tools(session)
    return {
        metadata.name: make_crewai_tool(
            metadata,
            make_args_model(metadata),
            session,
            owner_loop,
        )
        for metadata in discovered
    }


async def crewai_kickoff_async_discovery_demo() -> None:
    async with open_mcp() as session:
        owner_loop = asyncio.get_running_loop()
        all_tools = await build_crewai_tools(session, owner_loop)

        # Keep the agent's available tools limited to free discovery calls.
        discovery_tools = [
            all_tools["stratigraphy.list"],
            all_tools["payment.get_info"],
        ]
        analyst = Agent(
            role="Bitcoin Stratigraphy catalog analyst",
            goal="Report dataset coverage using only free discovery tools.",
            backstory=(
                "You inspect published MCP discovery data and never request "
                "paid or state-changing operations."
            ),
            tools=discovery_tools,
            allow_delegation=False,
            verbose=False,
        )
        task = Task(
            description=(
                "Use the available free discovery tools to inspect the "
                "Bitcoin Stratigraphy dataset bounds and current advertised "
                "tool prices. Do not attempt any other tool or paid action."
            ),
            expected_output=(
                "A concise summary of the reported dataset bounds and "
                "advertised prices, noting any unavailable data."
            ),
            agent=analyst,
        )
        crew = Crew(agents=[analyst], tasks=[task], verbose=False)

        # kickoff_async is an async method that runs the synchronous Crew
        # kickoff in a worker thread; the MCP session stays open on owner_loop.
        # Do not cancel this await and close the session while the thread can
        # still be executing tools.
        result = await crew.kickoff_async(inputs={})
        print(result)


if __name__ == "__main__":
    asyncio.run(crewai_kickoff_async_discovery_demo())
```

The last code block is runnable as a script in a configured CrewAI project.
Configure your chosen LLM provider separately using that provider's protected
environment credentials (CrewAI's default model may require `OPENAI_API_KEY`).
The crew uses an LLM and can incur that provider's inference charges even
though its MCP discovery calls are free. Keep provider keys out of the script.
For an already-running event loop, use `await
crewai_kickoff_async_discovery_demo()`; do not nest `asyncio.run()`. The
session and its transport remain open while `kickoff_async()` is running and
are closed only after crew execution finishes. If using CrewAI's native
`akickoff()` instead, implement an async `_arun()` pathway and use native
async MCP calls; do not reuse the thread bridge as though it were a same-loop
async tool.

## Payment, credentials, and operational safety

- Standard MCP clients, LangChain tools, and CrewAI tools **do not
  automatically pay HTTP 402 challenges**. A paid call may return an HTTP 402
  before an MCP tool result exists; this guide does not implement payment or
  retry behavior.
- Paid calls require an L402-aware HTTP transport and a payment client with
  explicit spending controls. A normal `streamable_http_client` setup is not
  an L402 payment transport. Read
  [`L402_AGENT_PAYMENTS.md`](L402_AGENT_PAYMENTS.md) before implementing a
  separately reviewed payment integration. Never turn a 402 into an
  automatic payment without checking the exact invoice, amount, scope,
  expiry, and wallet policy.
- Never place wallet secrets, macaroon credentials, preimages, or payment
  signatures in source code, prompts, logs, tool output, environment dumps,
  or checked-in framework configuration. Use a wallet integration designed
  for the deployment environment, least privilege, spending limits, and
  protected secret storage. Do not log raw payment challenges or
  authentication headers.
- `proof.submit` and `mesh.broadcast` can change state or distribute data.
  Protect them with explicit human approval and application-level
  authorization; an agent's prompt is not a security boundary.
- Apply request timeouts, cancellation, concurrency limits, and structured
  error reporting. MCP `isError` results and transport/HTTP failures should
  remain visible to the caller. Re-discover the tool list and query live
  prices as appropriate rather than relying on this static catalog.
- A timeout around CrewAI's thread-based `kickoff_async()` does not reliably
  stop its worker thread. Configure model/provider deadlines, and keep the
  MCP session open until that thread has actually finished; do not let a
  cancelled coroutine close a session that a worker may still be using.

For Claude Desktop setup, see
[`CLAUDE_DESKTOP_SETUP.md`](CLAUDE_DESKTOP_SETUP.md) and the broader client
configuration and tool catalog in [`CONNECT.md`](../CONNECT.md).

## API references checked

The example API names and usage were checked against current official
documentation and source:

- [MCP Python SDK: Writing MCP Clients](https://py.sdk.modelcontextprotocol.io/v1/client)
  (`ClientSession`, `initialize`, `list_tools`, `call_tool`, and
  `streamable_http_client`).
- [MCP Python SDK: Streamable HTTP API](https://py.sdk.modelcontextprotocol.io/api/mcp/client/streamable_http/).
- [LangChain `StructuredTool.from_function` reference](https://reference.langchain.com/python/langchain-core/tools/structured/StructuredTool/from_function)
  (`coroutine`, `args_schema`, and `infer_schema`).
- [CrewAI: Creating custom tools](https://docs.crewai.com/en/learn/create-custom-tools)
  (`BaseTool`, `args_schema`, `_run`, and async tool support).
- [CrewAI: Asynchronous crew kickoff](https://docs.crewai.com/en/learn/kickoff-async)
  (`kickoff_async` is thread-based; `akickoff` is native async).
- Repository [tool catalog and MCP connection notes](../CONNECT.md), with
  canonical registrations and schemas in
  [`artifacts/api-server/src/routes/mcp.ts`](../artifacts/api-server/src/routes/mcp.ts).
