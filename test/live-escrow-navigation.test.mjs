// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(
  new URL(
    "../artifacts/bitcoin-stratigraphy-dashboard/src/App.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("homepage places the live escrow terminal above the records workspace", () => {
  assert.match(app, /const LIVE_ESCROW_TERMINAL_ID = "live-escrow-terminal";/);
  const anchor = "id={LIVE_ESCROW_TERMINAL_ID}";
  assert.equal(app.split(anchor).length, 2, "the terminal id is rendered once");
  const stats = app.indexOf('<div className="stats-row">');
  const terminal = app.indexOf(anchor);
  const workspace = app.indexOf('<div className="workspace-grid">');
  assert.ok(stats > 0, "KPI cards are rendered");
  assert.ok(terminal > stats, "terminal follows the KPI cards");
  assert.ok(workspace > terminal, "records table follows the terminal");
  assert.match(
    app.slice(terminal, workspace),
    /<EscrowTerminal \/>\s*<\/section>\s*\{!query\.isError && \(\s*$/,
    "the terminal renders whether or not the dataset loads",
  );
});

test("header quick action and URL hash both scroll to the live escrow terminal", () => {
  assert.match(
    app,
    /href=\{LIVE_ESCROW_HASH\}\s*onClick=\{jumpToLiveEscrowTerminal\}[^>]*>\s*<Zap size=\{14\} \/> Live REST Escrow\s*<\/a>/,
  );
  assert.match(
    app,
    /scrollIntoView\(\{\s*behavior: reduceMotion \? "auto" : "smooth",\s*block: "start",\s*\}\)/,
  );
  assert.match(
    app,
    /revealFromHash\(\);\s*window\.addEventListener\("hashchange", revealFromHash\);/,
  );
});
