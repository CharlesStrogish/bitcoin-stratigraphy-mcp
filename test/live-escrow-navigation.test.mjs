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

test("homepage places the live escrow terminal above the command center", () => {
  assert.match(app, /const LIVE_ESCROW_TERMINAL_ID = "live-escrow-terminal";/);
  const anchor = "id={LIVE_ESCROW_TERMINAL_ID}";
  assert.equal(app.split(anchor).length, 2, "the terminal id is rendered once");
  const header = app.indexOf("<Header");
  const terminal = app.indexOf(anchor);
  const commandCenter = app.indexOf("<CommandCenter />");
  assert.ok(header > 0, "hero and quick actions are rendered");
  assert.ok(terminal > header, "terminal follows the hero");
  assert.match(
    app.slice(header, terminal),
    /\/>\s*<section\s*$/,
    "nothing renders between the hero and escrow section",
  );
  assert.ok(commandCenter > terminal, "command center follows the terminal");
  assert.match(
    app.slice(terminal, commandCenter),
    /<EscrowTerminal \/>\s*<\/section>\s*<main>\s*$/,
    "the terminal and command center render whether or not the dataset loads",
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
