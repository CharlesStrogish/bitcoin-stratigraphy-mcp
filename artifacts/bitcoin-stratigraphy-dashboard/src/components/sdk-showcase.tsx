import { useEffect, useRef, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import "./sdk-showcase.css";

const LANGCHAIN = [
  "from bitcoin_stratigraphy_mcp_client import L402Nip98Transport",
  "from langchain.agents import create_agent",
  "async with L402Nip98Transport(private_key, wallet_handler).langchain_tools() as tools:",
  "    agent = create_agent(model, tools=tools)",
];

const CREWAI = [
  "from crewai import Agent",
  "from bitcoin_stratigraphy_mcp_client.crewai import CrewAISwarmTools",
  "with CrewAISwarmTools(private_key, wallet_handler) as tools:",
  '    agent = Agent(role="Treasury auditor", goal="Audit swarm data", backstory="Enterprise risk team", tools=tools, llm=llm)',
];

const KEYWORDS = new Set(["from", "import", "async", "with", "as"]);
const FNS = new Set([
  "L402Nip98Transport",
  "create_agent",
  "CrewAISwarmTools",
  "Agent",
  "langchain_tools",
]);

function highlight(line: string) {
  const parts = line.split(/("[^"]*"|[A-Za-z_][\w.]*)/g);
  return parts.map((p, i) => {
    if (!p) return null;
    if (p.startsWith('"')) return <span key={i} className="tok-str">{p}</span>;
    if (KEYWORDS.has(p)) return <span key={i} className="tok-kw">{p}</span>;
    if (FNS.has(p)) return <span key={i} className="tok-fn">{p}</span>;
    if (p.includes(".") || p === "crewai")
      return <span key={i} className="tok-mod">{p}</span>;
    return <span key={i}>{p}</span>;
  });
}

type CopyState = "idle" | "copied" | "error";

function CodePanel({ id, label, lines }: { id: string; label: string; lines: string[] }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(lines.join("\n") + "\n");
      setState("copied");
    } catch {
      setState("error");
    }
    timer.current = window.setTimeout(() => setState("idle"), 2400);
  }

  const status =
    state === "copied"
      ? `${label} snippet copied to clipboard.`
      : state === "error"
        ? "Copy failed: clipboard access is unavailable. Select the code manually."
        : "";

  return (
    <div className="sdk-panel" data-testid={`panel-sdk-${id}`}>
      <div className="sdk-panel-bar">
        <span>
          <b>{label}</b> / python / 4 lines
        </span>
        <button
          type="button"
          className="sdk-copy"
          onClick={copy}
          data-state={state}
          aria-label={`Copy ${label} integration code`}
          data-testid={`button-copy-${id}`}
        >
          {state === "copied" ? (
            <Check size={12} aria-hidden="true" />
          ) : state === "error" ? (
            <TriangleAlert size={12} aria-hidden="true" />
          ) : (
            <Copy size={12} aria-hidden="true" />
          )}
          {state === "copied" ? "Copied" : state === "error" ? "Failed" : "Copy"}
        </button>
      </div>
      <pre
        className="sdk-code"
        tabIndex={0}
        aria-label={`${label} integration code`}
        data-testid={`code-${id}`}
      >
        <code>
          {lines.map((line, i) => (
            <span className="sdk-line" key={i}>
              <span className="sdk-ln" aria-hidden="true">{i + 1}</span>
              {highlight(line)}
            </span>
          ))}
        </code>
      </pre>
      <div className="sdk-status" role="status" aria-live="polite" data-testid={`status-copy-${id}`}>
        {status}
      </div>
    </div>
  );
}

export function SdkShowcase() {
  return (
    <section id="native-python-sdks" className="sdk-showcase" aria-labelledby="sdk-showcase-title" data-testid="section-sdk-showcase">
      <div className="sdk-showcase-head">
        <div className="eyebrow">
          <span className="eyebrow-line" /> PYTHON MCP CLIENT / AGENT FRAMEWORKS
        </div>
        <h2 id="sdk-showcase-title">Frictionless Swarm Integration</h2>
        <p>
          The SDK automatically handles <strong>NIP-98 signatures</strong> and{" "}
          <strong>L402 Lightning Macaroons</strong> behind the scenes: every request
          is Schnorr-signed, and payment challenges are routed to your connected
          wallet handler, which approves and returns the preimage.
        </p>
        <span className="sdk-dist" data-testid="text-sdk-distribution">
          bitcoin-stratigraphy-mcp-client
        </span>
      </div>
      <div className="sdk-panels">
        <CodePanel id="langchain" label="LangChain" lines={LANGCHAIN} />
        <CodePanel id="crewai" label="CrewAI" lines={CREWAI} />
      </div>
      <p className="sdk-note">
        Supply a configured <code>private_key</code>, an async{" "}
        <code>wallet_handler</code>, and your <code>model</code> (LangChain) or{" "}
        <code>llm</code> (CrewAI). Keep agent execution inside the context so the MCP
        session stays open while tools run. The distribution is supplied as source
        from <code>sdk/python/mcp-client</code>.{" "}
        <a
          className="sdk-docs"
          href={`${import.meta.env.BASE_URL}docs`}
          data-testid="link-sdk-docs"
        >
          Read the setup guide
        </a>
        .
      </p>
    </section>
  );
}
