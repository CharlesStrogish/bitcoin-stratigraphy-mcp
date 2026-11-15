# L402 Machine-to-Machine Interceptor

A lightweight, **zero-runtime-dependency** Python package for synchronous MCP
HTTP calls inside CrewAI or LangChain tools. A `401 Unauthorized` or
`402 Payment Required` sends a human procurement alert, prints the same message,
and terminates the calling agent loop with exit code 1. No automatic payment,
credential minting, or silent retry.

## Install

Python 3.10 or later. From this repository:

```sh
pip install ./artifacts/l402-interceptor
```

In a standalone checkout of this directory, use `pip install .`. The distribution
is named `l402-interceptor`; the import is `l402_interceptor`. It has no dependency
on the surrounding workspace or either agent framework. See `LICENSE.md` for the
repository's AGPLv3/commercial licensing terms.

## Three-line injection

With your existing synchronous `client` (for example a requests Session or httpx
Client), configure a private `SWARM_WEBHOOK_URL` in your deployment's secret
manager, then inject:

```python
from l402_interceptor import L402Interceptor
interceptor = L402Interceptor(os.environ["SWARM_WEBHOOK_URL"])
mcp_request = interceptor.wrap(client.request)
```

Import `os` in your application. **Use `mcp_request` for every MCP call in your
tool functions instead of `client.request`.** Construct one interceptor per swarm
run, outside the tool function. Wrapping an unrelated client does not intercept
the internal transport of an MCP SDK. Do not wrap all of your application's HTTP
traffic: an unrelated service's 401 would trigger the same procurement alert.

Existing client arguments, headers and successful responses are preserved.
Configure bounded timeouts and redirect behavior on that client. The built-in
client below disables redirects and has a bounded timeout.

### LangChain tool

```python
import os
import httpx
from langchain_core.tools import tool
from l402_interceptor import L402Interceptor

client = httpx.Client(timeout=10, follow_redirects=False)
interceptor = L402Interceptor(os.environ["SWARM_WEBHOOK_URL"])
mcp_request = interceptor.wrap(client.request)

@tool
def call_audit_mcp(arguments: dict) -> str:
    """Call the authenticated audit MCP tool."""
    response = mcp_request(
        "POST", os.environ["MCP_URL"],
        headers={
            "Authorization": os.environ["MCP_AUTHORIZATION"],
            "Accept": "application/json, text/event-stream",
        },
        json=arguments,
    )
    response.raise_for_status()
    return response.text

# Add call_audit_mcp to your agent's tools; close client during application cleanup.
```

`arguments` must be the valid JSON-RPC envelope and session/protocol headers
required by your server. This wrapper is not a new MCP protocol implementation.
Use your existing server-issued authorization header; a NIP-98 identity signature
and a paid macaroon/L402 proof are distinct. This package neither invents nor
validates credentials.

### CrewAI

Use the same tool body and initialization above, replacing the decorator import:

```python
from crewai.tools import tool

@tool("Authenticated audit MCP")
def call_audit_mcp(arguments: dict) -> str:
    """Call the authenticated audit MCP tool."""
    response = mcp_request(
        "POST", os.environ["MCP_URL"],
        headers={"Authorization": os.environ["MCP_AUTHORIZATION"]},
        json=arguments,
    )
    response.raise_for_status()
    return response.text

# Agent(..., tools=[call_audit_mcp])
```

Frameworks and HTTP clients are installed separately by the consuming app.
These are custom synchronous tools, not callback handlers or global patches.
Async transports, stdio MCP and SDK-internal SSE handling are not intercepted.

### Built-in HTTP client

No requests/httpx installation is necessary for ordinary buffered calls:

```python
from l402_interceptor import L402Interceptor

gate = L402Interceptor(os.environ["SWARM_WEBHOOK_URL"])
response = gate.request("POST", os.environ["MCP_URL"], headers=auth_headers, json=rpc)
data = response.json()
```

The built-in client buffers successful responses; use your existing MCP transport
for streaming responses.

## Slack and Microsoft Teams

Slack is the default: JSON `{"text": "<message below>"}`. For a Teams Workflows
webhook configured to receive Adaptive Card attachments, use
`L402Interceptor(webhook_url, platform="teams")`. It sends a `type: message`
envelope with an Adaptive Card TextBlock containing the identical text. Configure
the workflow to accept this schema; arbitrary Teams workflow triggers may expect
a different schema. Markdown rendering can vary, but the message text is exact:

```text
🚨 **Swarm Halted: EU AI Act Compliance Lock** 🚨
I am halted due to missing Zero-Knowledge auditing credentials. Please authorize a $500 L402 API block so I can securely resume operations: https://buy.stripe.com/8x228q0IE9A40uHehz7ss00
```

This is the configured procurement message, **not a legal compliance determination
or proof that the failed request required a Zero-Knowledge credential**. The
interceptor detects HTTP status codes, not the underlying reason or proof type.
401 may also mean expired or malformed authorization.

## Halt and recovery behavior

- Both returned 401/402 responses and raised urllib / requests / httpx HTTP
  status errors are intercepted.
- One webhook attempt per instance. The instance stays latched shut, so later
  requests fail locally without sending repeated alerts or contacting MCP.
- `SwarmHalted` subclasses `SystemExit`, not `Exception`, to avoid ordinary tool
  retry handlers swallowing it. It carries `status_code` and exit code `1`.
  The same message is printed to stdout before notification.
- Webhook timeout/failure still halts, with a sanitized delivery warning.
  HTTPS is required; redirects are disabled for webhook delivery.
- MCP credentials, request data and server response bodies are never sent to
  the webhook or printed by the interceptor.
- Other statuses and network errors preserve the wrapped client's behavior.
- Stop supervisors from automatically restarting unpaid runs. In-process async
  or parallel worker orchestration must explicitly propagate cancellation;
  this wrapper cannot retract already in-flight work or kill other processes.

If your application needs to keep its host process alive, catch `SwarmHalted` at
the **outer swarm boundary**, shut down workers, and return to the operator UI.
Do not catch it inside a retry loop. After an operator purchases and provisions
valid credentials, restart with a **new** interceptor. Payment Link navigation
alone is not payment confirmation, credential fulfillment, or permission to
resume.

## Local verification (no secrets or external traffic)

From this package directory:

```sh
PYTHONPATH=src python -m unittest discover -s tests -v
PYTHONPATH=src python examples/mock_402.py
```

The script starts an ephemeral loopback HTTP server with mock MCP and Slack
endpoints. A real local POST receives 402, then a second POST delivers the alert
to the local webhook, which prints and verifies the JSON. It catches the expected
exit only to assert the result and prints `PASS`. Production use does not catch
the exit. Loopback HTTP is enabled explicitly only for this demonstration.
