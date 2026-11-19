# GitHub conversion, external-link, and boilerplate-integrity audit

## Scope and safety

Audit date: November 19, 2026.

- Primary repository: `CharlesStrogish/bitcoin-stratigraphy-mcp`.
- Primary surfaces: `README.md`, `CONNECT.md`, `SECURITY.md`, `LICENSE.md`,
  `glama.json`, the tracked `.github/` workflow, and all 23 pre-existing public
  `docs/` files. Legacy-host discovery searched all tracked text files, not just
  these documentation surfaces.
- Companion repository: `CharlesStrogish/zk-flight-recorder-template`,
  inspected at commit `ed42955764c3a40565cb12825f11b09c338f98d4`.
  All eight tracked files were inspected or searched, including the README,
  Python sources, setup declaration, example environment, tests, and lockfile.
- Companion inspection was read-only in a temporary directory outside the
  workspace. No companion files, branches, dependencies, or remote state were
  changed. Its paid example and tests were not executed.
- Network verification used unauthenticated, read-only HEAD/GET requests.
  No MCP execution, scanner request, invoice, checkout, email, or payment was
  initiated. The MCP transport and paid scanner endpoints were not probed.
- No backend API routes, L402 logic, fulfillment loops, database schemas, MCP
  implementations, legal disclaimers, liability notices, or technical boundary
  disclosures were changed. Nothing was pushed or published.

## Primary repository: itemized corrections

| ID | File | Finding | Correction |
| --- | --- | --- | --- |
| P1 | `README.md`, top discovery bar | The November 19 OWASP MCP03 tool-poisoning defense article was absent. | Added a direct, labeled link alongside the existing discovery links, within the first 12 lines. The published article returned HTTP 200. |
| P2 | `CONNECT.md`, configuration references | The former Goose documentation address returned HTTP 404 on both HEAD and GET. | Replaced it with the current official guide, `https://goose-docs.ai/docs/getting-started/using-extensions/`, verified HTTP 200. |
| P3 | `README.md`, Machine Discovery section | GitHub's rendered-README API showed escaped script tags and unformatted JSON-LD as ordinary text. | Wrapped the existing script and JSON in a labeled HTML fence. The JSON-LD payload, script tags, metadata values, surrounding disclosures, and headings are unchanged. |

The obsolete Goose target was
`https://block.github.io/goose/docs/getting-started/using-extensions`.
The current guide was corroborated through official Goose documentation;
search results still included the obsolete address, so successful live
verification was required before replacement.

## Primary repository: other findings

### Canonical host and discovery

No advertised legacy hosting URLs remain in tracked public files.
Legacy-host strings found in three test files intentionally exercise redirect
and hostname-spoofing behavior; those assertions were preserved.
`glama.json` remains valid JSON and retains its enterprise registry identity,
ownership, release, pricing, and discovery metadata.

The hosted quick-connect remains:

```sh
npx add-mcp 'https://bitcoinstratigraphy.com/mcp'
```

No tool catalog, payment price, protocol version, security claim, or legal
qualification was rewritten.

### External links, badges, procurement, and email

The inventory contained 53 distinct HTTPS targets across `README.md`,
`CONNECT.md`, and `SECURITY.md`, including the requested new article:

- 50 returned HTTP 200 in the initial check.
- The Goose target returned HTTP 404 and was replaced with a verified HTTP 200
  target. The final documentation therefore has 51 verified HTTP 200 targets.
- The npm package website returned HTTP 403 to both HEAD and GET. This is an
  access restriction, not evidence of a missing package. A separate read-only
  GET to `https://registry.npmjs.org/mcp-remote/latest` returned HTTP 200 and
  identified `mcp-remote` version `0.16.7`. The normal npm website link was
  preserved; its rendered page remains independently unverified.
- The canonical MCP transport URL was deliberately not requested. Its spelling
  and documented path were checked against the repository's existing contracts.

All six README badge images returned HTTP 200. Their link wrappers, labels,
image syntax, and destination links were retained.

The procurement homepage and enterprise-licensing anchor target returned HTTP
200. The licensing mail link is exactly
`mailto:licensing@bitcoinstratigraphy.com`, with matching visible address.
Email syntax was checked without sending a message or claiming mailbox
deliverability.

These are point-in-time reachability observations. HTTP 200 alone does not
certify the accuracy or future availability of third-party content. GitHub
repository fragments were additionally checked against local document headings.
The continuity anchor was checked in published HTML; the client-rendered
licensing anchor was checked against its source and the rendered-site guard.

### GitHub Flavored Markdown

The audit inspected parsed headings, tables, links, image wrappers, code fences,
language labels, raw HTML, and relative repository paths. GitHub's own rendered
README was retrieved read-only to confirm the raw-script defect before editing.
The corrected block uses a standard HTML fence and preserves the exact
JSON-LD content for raw-source inspection.

The 86 pre-existing fenced blocks were closed correctly; the JSON-LD correction
adds one explicit fence. Shell, JSON, TypeScript, HTTP, Python, Mermaid, and
plain-text examples retained their content and language labels. One deliberately
unlabeled hash-concatenation formula in `docs/mcp-tasks-trace-context.md` remains
plain text rather than being mislabeled as an executable command.
The two paired details/summary sections in `docs/ARCHITECTURE.md` and the
copyright comment in `docs/agent-api.md` are intentional, balanced HTML.
No other malformed link wrappers, executable-code smart quotes, copied shell
prompts, or relative-link defects were identified.

## Companion repository: itemized issues, not patched

Locations below refer to the inspected companion commit, not the primary
workspace. These are documentation/integration findings, not evidence that
unimplemented capabilities should be advertised as already working.

| ID | Location | Finding | Recommended separate-repository correction |
| --- | --- | --- | --- |
| C1 | `README.md:31–34, 87–98, 112–124` | The README mentions MCP but never provides the live one-line `npx add-mcp` quick-connect. | Add the canonical quick-connect as an explicitly separate MCP-client setup step; preserve that the Python recorder itself calls the scanner. |
| C2 | `README.md:207–228, 254–294` | No reference to the Unstoppable Failover Protocol or current continuity/disaster-recovery guide was found anywhere in tracked files. | Link the upstream continuity protocol and explain its procurement/payment-path scope without implying this callback automatically pays, retries, or switches services. |
| C3 | `README.md:87–110, 230–252` | No OWASP MCP03 tool-integrity verification guidance, pinned tool-integrity manifest reference, or November 19 defense-guide link was found. | Add the defense-guide reference and describe independently pinned integrity verification for the separate MCP integration, not as a capability already supplied by scanner hashes. |
| C4 | `README.md:207–228` and repository-wide search | No reference to the 21% programmatic Agent Yield was found. | Document the upstream eligible allocation and link its terms, retaining the distinction between ledger allocation, eligibility, and authorized withdrawal; do not promise automatic recorder income. |
| C5 | `README.md:7–14`, compared with `flight_recorder.py:63–95` | The diagram labels authentication as NIP-98 Ed25519. NIP-98 uses Nostr Schnorr/secp256k1 signatures, and the included scanner client actually uses a funded Macaroon header, not NIP-98. | Correct the diagram's authentication terminology and distinguish upstream optional MCP identity from the implemented scanner path. |
| C6 | `README.md:7–14`, compared with `README.md:100–110, 249–252` and `flight_recorder.py:76–120` | The diagram depicts Hashcash, OpenTimestamps, and a Groth16-to-compliance path as the recorder's execution chain. The included scanner flow returns heuristic SHA-256 commitments, and Groth16-required mode fails closed before submission. Later disclosures explain this, but the prominent diagram conflicts with them. | Redraw the implemented scanner/journal path and visibly separate future/optional proof and anchoring integrations; retain every existing limitation and compliance disclosure. |

### Companion checks that passed

- No legacy hosting URLs, obsolete named MCP tools, mangled Markdown URLs,
  smart quotes/non-breaking spaces inside executable examples, or copied `$`
  shell prompts were found.
- The default `SCANNER_URL` in `.env.example`, the README, and the Python source
  is the canonical scanner URL. It must **not** be replaced with `/mcp`:
  scanner and MCP access are different contracts and products.
- The README's $500/100-call/30-day scanner block, 100,000-sat alternative, and
  qualified 250-sat standard core MCP price match the primary repository's
  current published documentation. This was not a paid live pricing quote.
- All eight README fences and its quick-start fragment were intact.
  The Python project/install instructions and blank example credential were
  inspected without installing or executing companion code.
- Nine non-paid documentation, registry, repository, and discovery URLs returned
  HTTP 200, including the architecture article, Glama badge, developer portal,
  Standard page, OpenAPI document, and agent guide.
- Negative URL-validation fixtures in the companion tests are deliberate test
  inputs, not production targets or defects.

## Verification

- `pnpm test`: **1,014 tests passed**, including the seven tests exposed by
  `pnpm test:site-integrity`; no existing tests were removed or changed.
- Rendered site guard: **31 route forms, 86 Markdown files, 47 clipboard
  control/state checks, and 753 link occurrences** passed. Desktop/mobile
  rendering, headings, internal links, code copying, and JSON-LD checks passed
  without console errors or mobile horizontal overflow.
- `pnpm test:python`: **280 tests passed** across all seven Python suites.
- `pnpm test:pipeline`: **28 tests passed**, with **100% statement and branch
  coverage**; zero missing statements or partial branches.
- `pnpm build`: **passed**, including workspace TypeScript checks.
- README metadata values and JSON-LD script payload were compared against the
  original and are byte-for-byte unchanged. `LICENSE.md` and `SECURITY.md` are
  unchanged.
- All six badge bodies were confirmed to contain SVG, without an inaccessible
  or missing-badge error. All eight GitHub document fragments resolved against
  local headings. The corrected Goose guide returned HTTP 200.
- The final report/source Markdown check and `git diff --check` passed.
- The companion checkout remained clean and was removed after inspection.

## External HTTPS target register

The register records the documentation's final targets. Fragments sharing a page
were each checked against their corresponding primary-repository headings or
published anchor where applicable. `200` denotes a successful read-only
reachability check, not a paid API execution or a security certification.

| Target | Result |
| --- | --- |
| `https://bitcoinstratigraphy.com` | 200 |
| `https://bitcoinstratigraphy.com/#enterprise-licensing` | 200 |
| `https://bitcoinstratigraphy.com/docs` | 200 |
| `https://bitcoinstratigraphy.com/cookbooks` | 200 |
| `https://bitcoinstratigraphy.com/developers/enterprise-troubleshooting` | 200 |
| `https://bitcoinstratigraphy.com/developers/#swarm-continuity` | 200 |
| `https://bitcoinstratigraphy.com/security` | 200 |
| `https://bitcoinstratigraphy.com/static/verify.html` | 200 |
| `https://bitcoinstratigraphy.com/LICENSE.md` | 200 |
| `https://bitcoinstratigraphy.com/llms.txt` | 200 |
| `https://bitcoinstratigraphy.com/.well-known/mcp.json` | 200 |
| `https://bitcoinstratigraphy.com/.well-known/mcp/server-card.json` | 200 |
| `https://bitcoinstratigraphy.com/.well-known/integrity.json` | 200 |
| `https://bitcoinstratigraphy.com/api/v1/compliance/revocation-snapshot` | 200; source confirmed a public read-only GET handler |
| `https://bitcoinstratigraphy.com/blog/defending-autonomous-ai-swarms-mcp-tool-poisoning-hijacking` | 200 |
| `https://bitcoinstratigraphy.com/mcp` | Not requested; protocol endpoint |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/CONNECT.md` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/CONNECT.md#claude-desktop` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/CONNECT.md#cursor` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/CONNECT.md#elizaos-character` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/CONNECT.md#zero-polling-execution-with-webhook_url` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/README.md#zero-polling-execution-webhook_url` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/LICENSE.md` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/SECURITY.md` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/glama.json` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/cookbooks/frameworks/README.md#what-the-agent-reports` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/tree/main/cookbooks/frameworks` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/cookbooks/frameworks/langchain_agent.py` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/cookbooks/frameworks/llamaindex_agent.py` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/ENTERPRISE_COMPLIANCE.md` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/enterprise-protocol-economics.md` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/tool-integrity.md` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/tool-integrity.md#signed-synchronous-tool-responses` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/docs/tool-integrity.md#webhook-callback-signatures` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/npm/mcp-server/README.md` | 200 |
| `https://github.com/CharlesStrogish/bitcoin-stratigraphy-mcp/blob/main/sdk/python/README.md` | 200 |
| `https://glama.ai/mcp/connectors/com.bitcoinstratigraphy/bitcoin-stratigraphy-enterprise-data-engine-and-agent-notary-hub` | 200 |
| `https://glama.ai/mcp/connectors/com.bitcoinstratigraphy/bitcoin-stratigraphy-enterprise-data-engine-and-agent-notary-hub/badges/score.svg` | 200; badge |
| `https://img.shields.io/badge/LangChain-Ready-1C3C3C` | 200; badge |
| `https://img.shields.io/badge/LlamaIndex-Ready-6366F1` | 200; badge |
| `https://img.shields.io/badge/OpenTimestamps-Integrated-F7931A` | 200; badge |
| `https://img.shields.io/badge/MCP%20Spec-2026--07--28-orange` | 200; badge |
| `https://img.shields.io/badge/Monetization-L402%20Lightning-yellow` | 200; badge |
| `https://modelcontextprotocol.io/specification/2026-07-28` | 200 |
| `https://l402.org` | 200 |
| `https://opentimestamps.org/` | 200 |
| `https://schema.org` | 200; JSON-LD vocabulary |
| `https://goose-docs.ai/docs/getting-started/using-extensions/` | 200; corrected target |
| `https://cursor.com/help/customization/mcp` | 200 |
| `https://docs.elizaos.ai/runtime/services` | 200 |
| `https://www.standardwebhooks.com/` | 200 |
| `https://www.npmjs.com/package/mcp-remote` | 403; website unverified, package registry metadata 200 |
