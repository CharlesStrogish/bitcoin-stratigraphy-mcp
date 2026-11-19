# Enterprise Swarm Starter

## Drop-in EU AI Act Compliance
**Give your AI swarm a visible authorization boundary—and a human who can unblock it.**

Start with a premium local command center, a working LangChain task, and a
pre-wired L402 interceptor. When a protected Bitcoin Stratigraphy request returns
401 or 402, your swarm stops and asks its operator for authorization through Slack.
Build your enterprise workflow instead of rebuilding procurement plumbing.

> “Drop-in EU AI Act Compliance” describes this starter's compliance-oriented
> workflow, not legal certification. Installing software or buying an API block
> does not establish compliance with the EU AI Act. The included viewer shows
> clearly labeled demonstration telemetry; it does not generate ZK proofs or
> collect live swarm evidence.

## From clone to command center

**Prerequisites:** Python **3.11–3.13** with pip, Node.js **22.16+** (24 recommended),
and **pnpm 10.26.1** on your PATH. The directory is a complete standalone repository;
no database, Docker, sibling folders, Replit account or LLM key is needed for the demo.

After cloning or choosing GitHub's **Use this template**:

```sh
npm run setup
npm start
```

`setup` installs the locked Python dependencies, installs the locked dashboard
dependencies, and builds the React application. `start` launches both the Node
dashboard and Python swarm.

**Open http://localhost:4173.** The local swarm performs an MCP handshake, attempts
`stratigraphy.get`, receives a mock 402, posts to a local mock Slack receiver, and
exits with code 1. Your dashboard stays available. No external request, real Slack
notification, invoice, LLM charge or payment occurs in default demo mode.

The swarm halting in the demo is the expected result, not an installation error.
The process supervisor never restarts an unauthorized swarm automatically.
Press **Ctrl+C** to close the dashboard. To change the port, set `VIEWER_PORT`.
If your interpreter is named `python3`, set `PYTHON=python3` before setup/start.

## What ships

| Component | Purpose |
| --- | --- |
| `swarm.py` | LangChain tool-first task calling `stratigraphy.get`; optional LLM agent extension |
| `packages/l402-interceptor/` | Vendored Phase 2 Python package; catches 401/402 and fails closed |
| `dashboard/` | Complete Phase 1 React Flight Recorder Viewer, including its private Node server |
| `demo_services.py` | Loopback-only MCP and Slack mocks for safe first-run verification |
| `scripts/start.mjs` | Cross-platform, shell-free local supervisor with shutdown handling |
| `uv.lock`, `requirements.lock` | Independent Python dependency resolution and pip install mapping |
| `dashboard/pnpm-lock.yaml` | Independent dashboard lock; no workspace dependencies |
| `.github/workflows/ci.yml` | Clean-checkout install, build, tests, type checks and dependency audits |

**LangChain is the included framework.** The template directory retains the
requested CrewAI-oriented distribution name, but CrewAI is not installed. To use
CrewAI, reuse `AuditMCP.snapshot` in a CrewAI custom tool and preserve the outer
`SwarmHalted` boundary. No hidden framework-wide monkeypatch is used.

## Put a human in control

On either **401 Unauthorized** or **402 Payment Required**, the interceptor:

1. Stops returning tool results to the agent.
2. Prints the exact message below.
3. Makes one bounded Slack webhook delivery attempt.
4. Exits the swarm with code 1, even if Slack is unavailable.

```text
🚨 **Swarm Halted: EU AI Act Compliance Lock** 🚨
I am halted due to missing Zero-Knowledge auditing credentials. Please authorize a $500 L402 API block so I can securely resume operations: https://buy.stripe.com/8x228q0IE9A40uHehz7ss00
```

The message is procurement copy. HTTP status alone does not diagnose the
credential failure, prove missing ZK credentials, or determine a legal obligation.
Microsoft Teams Adaptive Card delivery is also available in the vendored
interceptor by configuring `platform="teams"`.

## Connect the live service

Copy `.env.example` to `.env` and configure it privately. **Never commit `.env`,
paste keys into browser code, or add a `VITE_` prefix to credentials.**

| Setting | Purpose |
| --- | --- |
| `SWARM_MODE=live` | Explicitly permit real MCP and Slack calls |
| `SWARM_WEBHOOK_URL` | Your private HTTPS Slack incoming-webhook URL |
| `MCP_URL` | Defaults to `https://bitcoinstratigraphy.com/mcp` |
| `MCP_AUTHORIZATION` | Full, server-issued authorization header for the selected MCP tool |
| `BITCOIN_STRATIGRAPHY_API_KEY` | Optional funded scanner macaroon for viewer-server entitlement checks |
| `VIEWER_PORT` | Local dashboard port, default `4173` |

Run `npm start`. With no valid MCP authorization, the real backend's 401/402
halts the task and requests the **$500 Enterprise API Block** via Slack:

**[Authorize the $500 API block](https://buy.stripe.com/8x228q0IE9A40uHehz7ss00)**

After purchase, retrieve the entitlement through the issuer's actual fulfillment
process and configure the appropriate credential. Stop and restart the starter
with a fresh interceptor. This template does not implement Stripe fulfillment,
invoice payment, automatic retry, payment confirmation, or automatic resumption.

**Important credential distinction:** the viewer's key is an alias for a funded
`/api/scanner` macaroon. It is **not a universal MCP API key**. For an L402-protected
MCP call the server may require `Authorization: L402 <macaroon>:<preimage>` or
another explicitly supported, tool-scoped capability. A NIP-98 identity signature
is not a paid entitlement. Buying the advertised block does not guarantee every
MCP tool is included; confirm product scope with the issuer before purchasing.

## Extend the agent

The default `swarm.py` task invokes a real LangChain `@tool` deterministically:
the authorization attempt does not depend on an LLM choosing the tool.

For the optional LLM-driven extension, configure `OPENAI_API_KEY` and
`SWARM_MODEL=openai:gpt-4.1-mini` privately, select live mode, then run:

```sh
npm run start:agent
```

The first MCP call remains mandatory. Only after it succeeds does a standard
LangChain `create_agent` workflow summarize the authorized snapshot. This mode
can incur MCP and LLM charges. Replace the prompt and add your business tools
in `run_swarm`; keep protected MCP traffic behind the same interceptor.

The starter uses a bounded synchronous, handshake-compatible MCP JSON/finite-SSE
client. It is not a general streaming or asynchronous swarm runtime. In-flight
work in independently spawned processes needs its own cancellation wiring.

## Local deployment and production boundaries

The root `package.json` is the deployment entry point; Docker is not required.
For a local developer workstation, `npm run setup && npm start` is sufficient.
The viewer binds to loopback. For a managed production host, install dependencies
at build time, run the dashboard and swarm as separate supervised processes, put
the dashboard behind an authenticated TLS reverse proxy, and **do not configure
automatic restart on authorization failures**.

The dashboard remains the Phase 1 viewer: simulated proof/payment metrics, real
on-demand scanner entitlement checking, and a locked production state. It is
**not connected to swarm execution events in this release**. Neither an unlocked
viewer nor successful MCP access establishes regulatory compliance.

## Verify before you distribute

```sh
npm run check
npm test
npm run test:dashboard
npm run typecheck
npm run build
python scripts/smoke_start.py
python -m pip check
pnpm --dir dashboard --ignore-workspace audit --audit-level low
# With pip-audit installed in your development tooling:
python -m pip_audit --disable-pip --no-deps -r requirements-audit.txt
```

Tests cover a complete mock MCP handshake and tool invocation, 401/402 Slack
alerts, webhook failure, successful authorization-path handling, and safe defaults.
They never authorize real spending. A clean dependency audit is not a security
guarantee; rerun it before every public release.

### Refresh dependencies

With uv installed, run `uv lock`, then `python scripts/export_requirements.py`.
This also regenerates `requirements-audit.txt` from the registry requirements
(excluding the local package). Refresh the dashboard lock with
`pnpm --dir dashboard --ignore-workspace install`, rerun all checks, and review
changes before publishing. The local interceptor source is committed and versioned
with this starter.

## Publish as a GitHub template

1. Copy **this directory's contents** to a clean repository root, including
   dotfiles, the vendored package, both dependency locks and the license.
2. Confirm no `.env`, tokens, generated builds or dependency folders are tracked.
3. Push to the intended public repository and enable **Template repository** in
   GitHub repository settings.
4. Run the included clean-checkout CI and review its results before announcing.
5. Pin release tags, rerun dependency audits and document changes for adopters.

No GitHub repository is created, pushed or published by these scripts.

## License

The template and first-party bundled components use the existing
**AGPL-3.0-only / separately negotiated commercial** licensing terms in
`LICENSE.md`. AGPL allows commercial use when its conditions are met; it is not
a permissive-license template. Third-party libraries retain their own licenses.
