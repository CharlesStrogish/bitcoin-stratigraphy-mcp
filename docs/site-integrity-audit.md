# Site-wide copy-paste, URL, and markup integrity audit

## Scope and result

This audit covers every discovered Bitcoin Stratigraphy production HTML page,
every route declared in the dashboard router, all five blog posts, the public
developer and cookbook portals, the offline verifier, repository Markdown
including README.md, CONNECT.md and docs/, and frontend clipboard sources.

The completed rendered audit covered **31 route forms** (including slash
aliases), **85 Markdown files**, **47 clipboard control/state checks**, and
**752 link occurrences**. All route forms were checked at desktop and mobile
widths with no JavaScript exceptions or console errors.

The permanent regression guard rebuilds the dashboard before inspecting it.
It checks desktop and 390-pixel mobile rendering, JSON-LD parsing, headings,
executable snippets, clipboard payloads, and internal links. Page discovery
uses generated HTML and router declarations; Markdown discovery includes new,
untracked, non-ignored files as well as committed files.
Agent memory, internal tool/skill files, uploaded instructions, dependencies,
and ignored generated output are not public documentation and are excluded.

## Files and defects fixed

| File | Defect | Surgical correction |
| --- | --- | --- |
| `SWARM_DIRECTIVE.md` | The first section skipped from H1 to H3. | Changed the two peer section headings to H2; all wording retained. |
| `artifacts/crewai-enterprise-compliant-template/README.md` | The opening subtitle skipped from H1 to H3. | Changed that subtitle to H2; all wording retained. |
| `artifacts/bitcoin-stratigraphy-dashboard/src/components/command-center/mcp-tools-matrix.tsx` | A decorative dollar-sign prompt was nested inside the installation command's code element, contaminating manual code selection even though its Copy button already used the clean command. | Moved the decorative prompt outside the code element; preserved the command, button payload, and prompt display. |

No other substantive content or application behavior was changed.
No backend route, payment implementation, fulfillment loop, database schema,
MCP tool, marketing claim, technical boundary, or legal disclaimer was rewritten.

## Category findings

- **Mangled URLs:** No remaining malformed Markdown URLs were found in
  executable snippets, metadata, JSON-LD, or inspected clipboard payloads.
  The previous November 19 article corrections remain intact.
- **Copy-paste hazards:** The decorative install prompt above was the only
  executable-code copy hazard found. No smart-quote or non-breaking-space
  defects were found in executable snippets.
- **Clipboard integrity:** Inspected direct clipboard calls, literal and
  templated snippet sources, shared copy components, framework tabs, public
  explorer request/result controls, and cookbook source-copy controls.
  Deliberate Markdown badge payloads remain valid Markdown, not CLI commands.
  Intake forms, legal clauses, JSON records, email addresses, invoices, and
  macaroons are data rather than executable commands.
- **Headings:** Fixed the two documentation files listed above.
  No remaining duplicate rendered H1, repeated hero/body title, or skipped
  heading levels were found.
- **JSON-LD and links:** Every discovered JSON-LD block is parsed with
  JSON.parse, including decoded URL values. Local page and cookbook links
  are requested through the production frontend and existing read-only
  documentation handlers. Missing files, repository anchors, page anchors,
  HTTP errors, and unknown routes masquerading as SPA HTTP 200 responses
  fail the guard. No remaining broken internal links were found.

## Permanent regression coverage

The guard is automatically included in the existing Node test suite and can
also be run separately with `pnpm test:site-integrity`.

- `tests/site-integrity.test.mjs`: positive and deliberately broken fixtures,
  repository/source audit, fresh production build, and full rendered-site audit.
- `scripts/site-integrity.mjs`: Markdown, heading, code, metadata, JSON-LD,
  repository-link, and frontend/clipboard-source inspection.
- `scripts/site-integrity-browser.mjs`: isolated Chromium inspection at desktop
  and mobile widths, actual clipboard-write interception, and framework tabs.
- `scripts/audit-site-integrity.mjs`: production routing, documentation serving,
  dynamic route discovery, source inspection, and link verification.

The test fails explicitly if Chromium or the production build is unavailable.
It does not skip the rendered-site checks or rely on stale generated output.

## Safety and verification boundaries

The browser audit uses an isolated local production frontend. It intercepts
clipboard writes to inspect their exact arguments and uses inert catalog and
health-result fixtures for the developer explorer. Cookbook source requests
read local repository files. Application API requests and analytics are blocked:
the audit never creates or pays an invoice, submits a scan, sends a webhook,
or modifies application data.

Read-only API links that belong to another service are checked against explicit
source route registrations, including aliases and imported path constants;
they are not requested against the live paid backend. Runtime invoices,
macaroons, escrow records, and user-provided content retain their existing
application tests and are not claimed to have been issued in this audit.

This is a development/build integrity audit, not a production deployment,
a security certification, or a guarantee that a copied integration will run
without its documented dependencies, credentials, and placeholder values.

## Verification results

- Full Node suite: **1,014 passed**, preserving all previous 1,007 tests and
  adding seven permanent guard tests.
- Full Python suites: **280 passed**.
- Separate pipeline gate: **28 passed**, with **100% statement and branch coverage**.
- Full workspace production build and TypeScript checks: **passed**.
- Desktop and mobile rendered-site guard: **passed**, with no JavaScript
  exceptions, console errors, or mobile horizontal overflow.
- Manual desktop/mobile preview screenshots: **rendered cleanly**.
