# Article 12 Flight Recorder Viewer

A local-first Bitcoin Stratigraphy command center for enterprise swarm developers.
Free, open-source viewer under AGPL-3.0-only; the hosted API is a separate paid service.

## Phase 1 scope

- Dark command center with sample proof records and sample L402 settlement metrics.
- Search, inspect and pause the demonstration feed.
- Server-side `BITCOIN_STRATIGRAPHY_API_KEY` configuration and real, on-demand entitlement verification.
- Locked production state with procurement link for the **$500 Enterprise API Block**:
  https://buy.stripe.com/8x228q0IE9A40uHehz7ss00

**All telemetry is demonstration data in this release, including after entitlement verification.**
This release does not ingest live swarm events, generate ZK proofs, settle micropayments,
or establish legal compliance. A paid API block does not by itself establish regulatory compliance.

## Run independently

Requires Node.js 22.16+ (Node 24 recommended) and pnpm 10.
Copy this directory to its own repository; no shared workspace package is required.

```sh
pnpm install --ignore-workspace
cp .env.example .env
# Edit .env locally; never commit or share its contents.
pnpm dev
```

Open http://localhost:4173. Without a key, the viewer remains in locked demo mode.
All assets build locally; no database or Replit account is required.

### Production/local distribution

```sh
pnpm build
pnpm start
```

The Node server defaults to loopback, not a public interface. For a deliberately
network-accessible deployment, set `HOST=0.0.0.0`. Protect it with your own access
controls; the Phase 1 viewer has no multi-user login. Never expose this development
server to an untrusted network.

In the existing monorepo use
`pnpm --filter @workspace/flight-recorder-viewer run dev`.
Replit supplies `BASE_PATH=/flight-recorder-viewer/` and a managed port.

## Credentials and verification

`BITCOIN_STRATIGRAPHY_API_KEY` is a **server-only configuration name** for a
funded prepaid **scanner macaroon**, optionally prefixed with `Macaroon `.
It is not a new universal API-key authentication scheme, Stripe secret, wallet
pairing key, or an unrestricted token for every MCP tool.

After configuring `.env`, restart the viewer and select **Verify connection**.
The server contacts only `https://bitcoinstratigraphy.com/api/mint-macaroon`
with the supplied capability to confirm the issuer's existing funded scanner
grant. It consumes no scanner credit, creates no viewer-initiated invoice,
and never initiates payment. Verification may record the existing settlement
at the issuer. Invalid, expired, unpaid or revoked credentials remain locked.
A green state means that this entitlement check succeeded, not that mock
telemetry became real or that remaining credits were independently measured.

The credential is never returned to the browser, embedded in a build,
stored in localStorage, accepted from a client form or logged.
The local API returns only non-secret status. Verification is explicit, bounded,
rate-limited and rejects cross-site browser requests.

The Stripe Payment Link is procurement navigation, **not payment verification or
credential provisioning**. Payment Link fulfillment must be configured separately;
the viewer cannot infer payment from a return URL. Retrieve your funded capability
through the existing issuer workflow or your operator before configuring it.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

Tests use synthetic credentials and mocked issuer responses. They never buy an API
block, call paid tools, or transfer real funds.

## Open-source release

This folder contains its own package manifest, TypeScript configuration,
server, example configuration, tests, README and license. Exclude `node_modules`,
`dist`, `.env*` other than `.env.example`, and Replit artifact metadata when
extracting it. Keep the copyright and AGPL license when publishing to GitHub.
No new GitHub repository or release has been created by this scaffold.
