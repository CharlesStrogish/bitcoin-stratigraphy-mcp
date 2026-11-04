import asyncio
import sys
from types import ModuleType
from unittest.mock import patch

import pytest

from bitcoinstratigraphy_agent_yield import FiduciaryError, with_fiduciary_yield


def test_native_langchain_sync_and_async(setup_client):
    pytest.importorskip("langchain_core.tools")
    from langchain_core.tools import StructuredTool

    s = setup_client(free=True)
    config = with_fiduciary_yield({"fiduciary": s.policy, "framework": "langchain"})
    tool = config["tools"][1]
    assert isinstance(tool, StructuredTool)
    assert tool.args_schema["properties"]["height"]["type"] == "integer"
    assert tool.invoke({"height": 1}).payload[0]["text"] == "free"
    assert asyncio.run(tool.ainvoke({"height": 1})).payload[0]["text"] == "free"
    assert not s.payments


def test_native_autogen_async_and_schema(setup_client):
    pytest.importorskip("autogen_core.tools")
    from autogen_core import CancellationToken
    from autogen_core.tools import BaseTool

    s = setup_client(free=True)
    config = with_fiduciary_yield({"fiduciary": s.policy, "framework": "autogen"})
    tool = config["tools"][1]
    assert isinstance(tool, BaseTool)
    assert tool.schema["parameters"]["required"] == ["height"]
    assert (
        asyncio.run(tool.run_json({"height": 1}, CancellationToken())).payload[0][
            "text"
        ]
        == "free"
    )
    cancelled = CancellationToken()
    cancelled.cancel()
    with pytest.raises(FiduciaryError, match="CANCELLED"):
        asyncio.run(tool.run_json({"height": 1}, cancelled))
    assert not s.payments


def test_crewai_public_basetool_contract_without_installing_crewai(
    setup_client, monkeypatch
):
    """Unit-test the CrewAI public BaseTool API without its large dependency tree."""
    from pydantic import BaseModel
    from typing import Any

    class BaseTool(BaseModel):
        name: str
        description: str
        args_schema: Any

        def run(self, **kwargs):
            parsed = self.args_schema.model_validate(kwargs)
            return self._run(**parsed.model_dump(exclude_unset=True))

    module = ModuleType("crewai.tools")
    module.BaseTool = BaseTool
    monkeypatch.setitem(sys.modules, "crewai", ModuleType("crewai"))
    monkeypatch.setitem(sys.modules, "crewai.tools", module)
    s = setup_client(free=True)
    config = with_fiduciary_yield({"fiduciary": s.policy, "framework": "crewai"})
    tool = config["tools"][1]
    assert isinstance(tool, BaseTool)
    assert tool.args_schema.model_json_schema()["properties"]["height"]["minimum"] == 0
    assert tool.run(height=1).payload[0]["text"] == "free"
    assert asyncio.run(tool._arun(height=2)).payload[0]["text"] == "free"

    class Agent(BaseModel):
        tools: list

    original = Agent(tools=[])
    wrapped = with_fiduciary_yield(original, fiduciary=s.policy, framework="crewai")
    assert original.tools == [] and len(wrapped.tools) == 2


@pytest.mark.parametrize(
    "framework,module",
    [
        ("langchain", "langchain_core.tools"),
        ("crewai", "crewai.tools"),
        ("autogen", "autogen_core.tools"),
    ],
)
def test_optional_dependencies_have_actionable_errors(setup_client, framework, module):
    s = setup_client()
    with patch.dict(sys.modules, {module: None}):
        with pytest.raises(FiduciaryError, match=f"INSTALL_{framework.upper()}"):
            with_fiduciary_yield({"fiduciary": s.policy, "framework": framework})


def test_no_private_internals_and_unknown_framework(setup_client):
    with pytest.raises(FiduciaryError, match="CONFIGURATION"):
        with_fiduciary_yield(object())
    s = setup_client()
    with pytest.raises(FiduciaryError, match="UNSUPPORTED_FRAMEWORK"):
        with_fiduciary_yield({"fiduciary": s.policy, "framework": "unrecognized"})
