// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { CopyTextButton } from "./copy-text-button";
import {
  FRAMEWORK_ADAPTERS,
  type FrameworkAdapter,
  type FrameworkId,
} from "./snippets";

/** Comments, strings, keywords and integers; everything else stays plain text. */
const PYTHON_TOKEN =
  /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(and|as|async|await|def|else|finally|for|from|if|import|in|not|or|return|try|with|None|True|False)\b|\b(\d+)\b/g;

function highlightPython(code: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(PYTHON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(code.slice(last, index));
    const [token, comment, string, keyword] = match;
    const kind = comment
      ? "comment"
      : string
        ? "string"
        : keyword
          ? "keyword"
          : "number";
    nodes.push(
      <span key={index} className={`cc-tok-${kind}`}>
        {token}
      </span>,
    );
    last = index + token.length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

function AdapterPanel({
  adapter,
  active,
}: {
  adapter: FrameworkAdapter;
  active: boolean;
}) {
  return (
    <div
      role="tabpanel"
      id={`cc-panel-${adapter.id}`}
      aria-labelledby={`cc-tab-${adapter.id}`}
      hidden={!active}
      tabIndex={0}
      className="cc-tabpanel"
      data-testid={`panel-framework-${adapter.id}`}
    >
      <div className="cc-adapter-meta">
        <span className={`cc-chip cc-chip-${adapter.status.tone}`}>
          {adapter.status.label}
        </span>
        <span className="cc-chip">{adapter.mode}</span>
      </div>
      <p className="cc-adapter-summary">{adapter.summary}</p>
      {adapter.statusNote && (
        <p className="cc-status-note">{adapter.statusNote}</p>
      )}
      <div className="cc-code">
        <div className="cc-code-bar">
          <span>{adapter.file} · excerpt</span>
          <CopyTextButton
            text={adapter.snippet}
            label="Copy"
            context={`${adapter.label} snippet`}
            description={`Copy the ${adapter.label} snippet`}
            testId={`button-copy-snippet-${adapter.id}`}
          />
        </div>
        <pre>
          <code>{highlightPython(adapter.snippet)}</code>
        </pre>
      </div>
      <div className="cc-links">
        {adapter.links.map((link) => (
          <a
            key={link.path}
            className="cc-link"
            href={`${import.meta.env.BASE_URL}${link.path}`}
            target="_blank"
            rel="noreferrer"
          >
            {link.label} <ExternalLink size={12} aria-hidden="true" />
          </a>
        ))}
      </div>
    </div>
  );
}

export function FrameworkAdapters() {
  const [active, setActive] = useState<FrameworkId>("langchain");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const last = FRAMEWORK_ADAPTERS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % FRAMEWORK_ADAPTERS.length
        : event.key === "ArrowLeft"
          ? (index - 1 + FRAMEWORK_ADAPTERS.length) % FRAMEWORK_ADAPTERS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(FRAMEWORK_ADAPTERS[next].id);
    tabs.current[next]?.focus();
  };

  return (
    <section
      className="cc-module cc-adapters"
      aria-labelledby="cc-adapters-title"
      data-testid="module-framework-adapters"
    >
      <div className="cc-module-head">
        <div className="cc-module-intro">
          <div className="section-kicker">03 · Framework adapters</div>
          <h3 id="cc-adapters-title">Autonomous AI Framework Adapters</h3>
          <p>
            Excerpts from the public cookbooks. Native MCP adapters are not
            Lightning wallets, so they carry a prepaid credential as headers.
          </p>
        </div>
      </div>

      <div className="cc-headers">
        <code>Authorization: L402 &lt;macaroon&gt;:&lt;preimage&gt;</code>
        <code>X-L402-Batch-Size: 100</code>
        <p>
          Buy a tool-scoped Macro-Macaroon with an L402-capable wallet, store
          the full value as <code>L402_AUTHORIZATION</code> in your secret
          store, and attach both headers. Never use Bearer auth or place
          credentials in prompts.
        </p>
      </div>

      <div className="cc-tablist" role="tablist" aria-label="AI framework">
        {FRAMEWORK_ADAPTERS.map((adapter, index) => (
          <button
            key={adapter.id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`cc-tab-${adapter.id}`}
            aria-selected={active === adapter.id}
            aria-controls={`cc-panel-${adapter.id}`}
            tabIndex={active === adapter.id ? 0 : -1}
            className="cc-tab"
            onClick={() => setActive(adapter.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            data-testid={`tab-framework-${adapter.id}`}
          >
            {adapter.label}
          </button>
        ))}
      </div>
      {FRAMEWORK_ADAPTERS.map((adapter) => (
        <AdapterPanel
          key={adapter.id}
          adapter={adapter}
          active={active === adapter.id}
        />
      ))}
    </section>
  );
}
