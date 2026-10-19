---
name: Layout overflow checks
description: Measuring responsive containment precisely when full-page screenshots are too small to read.
---

The workspace has Chromium at `/repl/tools/bin/chromium` but no Playwright or
Puppeteer package. Node 24's built-in `WebSocket` can drive it over the
DevTools protocol: launch with `--headless=new --remote-debugging-port`, read
`/json/list`, then use `Emulation.setDeviceMetricsOverride`, `Page.navigate`
and `Runtime.evaluate`. Compare `scrollWidth` with `clientWidth`, and list
elements that extend past the viewport without an overflow-clipping ancestor.

**Why:** Full-page mobile screenshots of the dashboard shrink below legibility.
Measuring at 360, 390, 768, 1024 and 1440 px gives a definite containment
answer.

**How to apply:**
- Select a `/json/list` target with `type === "page"`, not the first entry.
  Chromium also exposes an extension background target; navigating it returns
  `net::ERR_ABORTED` and an empty body instead of the application.
  **Why:** Target ordering is not stable, and the extension can appear first.
- Every page load polls the API, so keep runs few (see homepage-polling-budget.md).
- The wrapper's child processes can outlive it; give each run its own
  `--user-data-dir` so leftovers can be found.
- Chromium processes with a `playwright_chromiumdev_profile` profile belong to
  the screenshot tool. Do not kill them.
- Verify smooth scrolling with animation-frame samples, not a single delayed
  measurement. **Why:** Headless Chromium can defer animation start past an
  arbitrary timeout even when the scroll animates correctly.
