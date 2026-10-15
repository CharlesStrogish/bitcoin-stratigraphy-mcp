// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { FrameworkAdapters } from "./framework-adapters";
import { McpToolsMatrix } from "./mcp-tools-matrix";
import { TelemetryFeed } from "./telemetry-feed";
import "./command-center.css";

export function CommandCenter() {
  return (
    <section
      id="command-center"
      className="command-center"
      aria-labelledby="command-center-title"
      data-testid="section-command-center"
    >
      <header className="cc-head">
        <div className="eyebrow">
          <span className="eyebrow-line" />
          Machine-native interfaces
        </div>
        <h2 id="command-center-title">
          Enterprise &amp; Machine-Native Command Center
        </h2>
        <p>
          Everything an autonomous agent needs to discover, pay for and verify
          Bitcoin stratigraphy: the canonical MCP catalog with live fees, the
          settlement and Merkle telemetry behind it, and framework adapters that
          carry L402 credentials.
        </p>
      </header>
      <McpToolsMatrix />
      <div className="cc-split">
        <TelemetryFeed />
        <FrameworkAdapters />
      </div>
    </section>
  );
}
