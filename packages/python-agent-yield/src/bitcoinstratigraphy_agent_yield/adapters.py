"""Lazy, native framework adapters. No framework dependencies in the base wheel."""

import copy
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .client import FiduciaryClient
from .errors import FiduciaryError


@dataclass(frozen=True)
class AgentTool:
    name: str
    canonical_name: str
    description: str
    input_schema: dict
    client: FiduciaryClient

    def invoke(self, arguments=None, **kwargs):
        return self.client.call_tool(
            self.canonical_name, arguments if arguments is not None else kwargs
        )

    async def ainvoke(self, arguments=None, **kwargs):
        return await self.client.acall_tool(
            self.canonical_name, arguments if arguments is not None else kwargs
        )


def _argument_model(tool):
    from pydantic import ConfigDict, create_model

    # Forward the original JSON Schema to the model provider without flattening
    # enums, nested objects, unions, or refs. MCP remains the authoritative
    # validator; framework-side parsing must not coerce or drop arguments.
    schema = copy.deepcopy(tool.input_schema)
    required = schema.get("required", [])
    fields = {
        name: (Any, ... if name in required else None)
        for name in schema.get("properties", {})
    }
    model = create_model(
        f"{tool.name}_Args", __config__=ConfigDict(extra="allow"), **fields
    )
    model.model_json_schema = classmethod(
        lambda cls, *args, **kwargs: copy.deepcopy(schema)
    )
    return model


def _langchain(tool):
    from langchain_core.tools import StructuredTool

    return StructuredTool.from_function(
        func=lambda **kwargs: tool.invoke(kwargs),
        coroutine=lambda **kwargs: tool.ainvoke(kwargs),
        name=tool.name,
        description=tool.description,
        args_schema=copy.deepcopy(tool.input_schema),
        infer_schema=False,
    )


def _crewai(tool):
    from crewai.tools import BaseTool

    class FiduciaryCrewTool(BaseTool):
        def _run(self, **kwargs):
            return tool.invoke(kwargs)

        async def _arun(self, **kwargs):
            return await tool.ainvoke(kwargs)

    return FiduciaryCrewTool(
        name=tool.name, description=tool.description, args_schema=_argument_model(tool)
    )


def _autogen(tool):
    from autogen_core.tools import BaseTool

    class FiduciaryAutoGenTool(BaseTool):
        def __init__(self):
            super().__init__(_argument_model(tool), object, tool.name, tool.description)

        @property
        def schema(self):
            return {
                "name": tool.name,
                "description": tool.description,
                "parameters": copy.deepcopy(tool.input_schema),
            }

        async def run(self, args, cancellation_token):
            if cancellation_token.is_cancelled():
                raise FiduciaryError("MCP_REQUEST_CANCELLED")
            return await tool.ainvoke(args.model_dump(exclude_unset=True))

    return FiduciaryAutoGenTool()


def with_fiduciary_yield(agent, *, fiduciary=None, framework=None):
    """Copy an agent config or a public-tools agent, discover, and append tools.

    Configs return a dict with a ``fiduciary`` client for lifetime management.
    Public-tools/Pydantic agents return a model_copy; their original is untouched.
    Already-built graph/private-internals agents must be wrapped at config time.
    """
    is_config = isinstance(agent, Mapping)
    if is_config:
        options = fiduciary if fiduciary is not None else agent.get("fiduciary", {})
        selected = framework or agent.get("framework", "custom")
        existing = list(agent.get("tools", []))
    else:
        if not callable(getattr(agent, "model_copy", None)) or not hasattr(
            agent, "tools"
        ):
            raise FiduciaryError("WRAP_AGENT_CONFIGURATION_NOT_PRIVATE_INTERNALS")
        if fiduciary is None:
            raise FiduciaryError("FIDUCIARY_CONFIGURATION_REQUIRED")
        options = fiduciary
        selected = framework or (
            "crewai" if type(agent).__module__.startswith("crewai") else "custom"
        )
        existing = list(agent.tools or [])
    if selected not in ("custom", "langchain", "crewai", "autogen"):
        raise FiduciaryError("UNSUPPORTED_FRAMEWORK")
    if not isinstance(options, Mapping):
        raise FiduciaryError("FIDUCIARY_CONFIGURATION_REQUIRED")
    client = FiduciaryClient(**options)
    try:
        tools = []
        for index, entry in enumerate(client.list_tools()):
            safe = f"fiduciary_{index}_{re.sub(r'[^a-zA-Z0-9_-]', '_', entry['name'])}"[
                :64
            ]
            if any(
                (
                    item.get("name")
                    if isinstance(item, dict)
                    else getattr(item, "name", None)
                )
                == safe
                for item in existing
            ):
                raise FiduciaryError("MCP_TOOL_NAME_COLLISION")
            tool = AgentTool(
                safe,
                entry["name"],
                entry.get("description") or entry["name"],
                copy.deepcopy(entry["inputSchema"]),
                client,
            )
            adapter = {
                "langchain": _langchain,
                "crewai": _crewai,
                "autogen": _autogen,
            }.get(selected)
            tools.append(adapter(tool) if adapter else tool)
        if is_config:
            return {**agent, "tools": existing + tools, "fiduciary": client}
        # CrewAI agents expose public tools but do not accept arbitrary client
        # fields. Tool closures retain the client; no global monkeypatching.
        return agent.model_copy(update={"tools": existing + tools})
    except ImportError:
        client.close()
        raise FiduciaryError(f"INSTALL_{selected.upper()}_FOR_NATIVE_ADAPTER") from None
    except BaseException:
        client.close()
        raise
