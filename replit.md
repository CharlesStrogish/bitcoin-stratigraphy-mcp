# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `node scripts/measure-api-startup.mjs --runs 5` — measure API cold-start readiness against a disposable local PostgreSQL (`--bundle` compares another build)
- `node scripts/measure-agent-api-startup.mjs --runs 5` — measure Enterprise Agent API (`/agent-api`, port 8000) cold-start readiness with network and storage cut off (`--root` compares a copy of earlier Python files)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

- API startup is listen-first: `artifacts/api-server/src/index.ts` binds the port and holds early requests, then imports the application bundle (`dist/server.mjs`). Escrow routes wait for durable-ledger recovery (503 otherwise, never a zero counter); the one-pass zk verifier warm-up and the first OpenTimestamps stamp wait 5 minutes after the first recovery attempt, so neither runs during a boot (proofs are verified on demand until then). Keep application imports and synchronous CPU work out of the boot window.
- The Enterprise Agent API (`/agent-api`, port 8000) is listen-first too: `main.py` verifies the license, then `agent_startup.serve()` binds the port before importing uvicorn, the request-holding gate (`agent_startup_gate.py`) and, on a daemon thread, `agent_api`. Early requests wait for the application's lifespan startup (503 with `Retry-After` after 60 s or on a load failure). `agent_startup.py` may import only lightweight standard-library modules.
- Sub-agent attribution (EU AI Act Article 12): a caller may declare `agent_id` (the `X-Agent-Id` header or the body field) when it requests an L402 challenge. The ID is bound as the `agent_id = <id>` macaroon caveat, enforced on every use by `middleware/l402.ts`, stored in `escrow_ledger_settlements`, and hashed into a 128-byte escrow Merkle leaf. The ID is self-declared, not authenticated; NIP-98 pubkey binding is separate.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Do not run `drizzle-kit push` unattended. The dev database also holds the autonomous-agent template's checkpoint table, which push offers to rename or drop. Apply new dev tables from `drizzle-kit export` output; publishing applies the production diff (choose "create" for new tables).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
