import { AGENT_COUNT } from "../engine/simulation.ts";

export function AgentGrid({ counts, total, running }: { counts: number[]; total: number; running: boolean }) {
  const per = total / AGENT_COUNT;
  return (
    <div className="sim-agents" role="img" aria-label={`${counts.filter(Boolean).length} of ${AGENT_COUNT} agents have emitted traces`} data-testid="grid-agents">
      {Array.from({ length: AGENT_COUNT }, (_, i) => {
        const c = counts[i] || 0;
        return <span key={i} title={`agent-${String(i).padStart(2, "0")}: ${c} traces`} className={`sim-agent ${c ? "on" : ""} ${running && c ? "live" : ""}`}
          style={{ opacity: c ? 0.35 + 0.65 * Math.min(1, c / per) : 1 }} />;
      })}
    </div>
  );
}
