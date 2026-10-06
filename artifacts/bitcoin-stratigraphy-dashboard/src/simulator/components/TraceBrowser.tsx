import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { LeafRecord } from "../engine/simulation.ts";

const PER_PAGE = 12;

export function TraceBrowser({ records, version, selected, onSelect }: {
  records: LeafRecord[]; version: number; selected: number | null; onSelect: (i: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records.slice();
    return records.filter((r) => `${r.index} ${r.trace.agent_id} ${r.trace.trace_id} ${r.trace.tool} ${r.trace.thought}`.toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, version, query]);
  const max = Math.max(0, Math.ceil(filtered.length / PER_PAGE) - 1);
  const p = Math.min(page, max);
  const rows = filtered.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE);
  return (
    <section className="panel sim-panel" aria-labelledby="sim-browser-h">
      <div className="panel-heading">
        <div><div className="section-kicker">Captured thoughts</div><h2 id="sim-browser-h">Trace browser</h2></div>
        <span className="row-indicator" aria-live="polite">{filtered.length} of {records.length}</span>
      </div>
      <div className="sim-search">
        <Search size={14} aria-hidden="true" />
        <input aria-label="Search captured thoughts" placeholder="Search agent, trace id, tool, thought" value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }} data-testid="input-trace-search" />
      </div>
      {rows.length === 0 ? (
        <div className="sim-empty">{records.length ? "No thoughts match this search." : "No traces captured yet. Run the simulation."}</div>
      ) : (
        <ul className="sim-list">
          {rows.map((r) => (
            <li key={r.index}>
              <button type="button" className={`sim-row ${selected === r.index ? "sim-row-on" : ""}`} aria-pressed={selected === r.index}
                onClick={() => onSelect(r.index)} data-testid={`button-trace-${r.index}`}>
                <span className="sim-row-id">#{r.index} / {r.trace.agent_id}</span>
                <span className="sim-row-text">{r.trace.thought}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pagination">
        <span>Page <strong>{filtered.length ? p + 1 : 0}</strong> of {filtered.length ? max + 1 : 0}</span>
        <div>
          <button type="button" onClick={() => setPage(Math.max(0, p - 1))} disabled={p === 0} data-testid="button-trace-prev"><ChevronLeft size={14} /> Previous</button>
          <button type="button" onClick={() => setPage(Math.min(max, p + 1))} disabled={p >= max} data-testid="button-trace-next">Next <ChevronRight size={14} /></button>
        </div>
      </div>
    </section>
  );
}
