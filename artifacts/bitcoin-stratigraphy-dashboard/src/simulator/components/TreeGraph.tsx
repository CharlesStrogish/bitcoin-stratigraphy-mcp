import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { LeafRecord } from "../engine/simulation.ts";

const WINDOW = 50;
type Peak = { start: number; width: number; hash: string };
const short = (h: string) => `${h.slice(0, 8)}...${h.slice(-4)}`;

export function TreeGraph({ peaks, root, size, pathHashes, selected, records, onSelect }: {
  peaks: Peak[]; root: string; size: number; pathHashes: string[]; selected: number | null;
  records: LeafRecord[]; onSelect: (i: number) => void;
}) {
  const [win, setWin] = useState(0);
  const maxWin = Math.max(0, Math.ceil(size / WINDOW) - 1);
  const w0 = Math.min(win, maxWin);
  useEffect(() => { if (selected !== null) setWin(Math.floor(selected / WINDOW)); }, [selected]);
  const leaves = records.slice(w0 * WINDOW, Math.min(size, (w0 + 1) * WINDOW));
  const W = 640;
  const H = 70 + Math.max(peaks.length, 1) * 34;
  const rootX = W - 110;
  const rootY = H / 2;
  return (
    <figure className="sim-graph" data-testid="graph-tree">
      <figcaption className="section-kicker">Rolling tree: perfect subtrees folded into the root</figcaption>
      {size === 0 ? (
        <div className="sim-empty">The tree is empty. Run the simulation to stream leaves into it.</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Merkle tree with ${size} leaves in ${peaks.length} perfect subtrees. Root ${root}`}>
          {peaks.map((p, i) => {
            const y = 30 + i * 34;
            const contains = selected !== null && selected >= p.start && selected < p.start + p.width;
            const w = Math.min(300, 40 + Math.log2(p.width + 1) * 28);
            return (
              <g key={p.start}>
                <path d={`M ${20 + w} ${y} C ${rootX - 120} ${y}, ${rootX - 120} ${rootY}, ${rootX} ${rootY}`} className={contains ? "sim-edge sim-edge-on" : "sim-edge"} />
                <rect x={20} y={y - 12} width={w} height={24} className={contains ? "sim-peak sim-peak-on" : "sim-peak"} />
                <text x={28} y={y + 4} className="sim-svgtext">{p.width} leaves [{p.start}..{p.start + p.width - 1}]</text>
                <text x={28 + w + 8} y={y - 16} className="sim-svghash" display="none">{short(p.hash)}</text>
              </g>
            );
          })}
          <rect x={rootX} y={rootY - 22} width={100} height={44} className="sim-root" />
          <text x={rootX + 50} y={rootY - 4} textAnchor="middle" className="sim-svgtext sim-svgroot">ROOT</text>
          <text x={rootX + 50} y={rootY + 12} textAnchor="middle" className="sim-svghash">{root.slice(0, 10)}</text>
        </svg>
      )}
      {size > 0 && (
        <div className="sim-leaves" data-testid="leaf-window">
          <div className="sim-leaves-bar">
            <button type="button" className="control-button" onClick={() => setWin(Math.max(0, w0 - 1))} disabled={w0 === 0} aria-label="Previous 50 leaves" data-testid="button-leaves-prev"><ChevronLeft size={13} /></button>
            <label className="sim-leaves-range">
              <span>Leaves {w0 * WINDOW}..{Math.min(size, (w0 + 1) * WINDOW) - 1}</span>
              <input type="range" min={0} max={maxWin} value={w0} onChange={(e) => setWin(Number(e.target.value))} aria-label="Leaf window" disabled={maxWin === 0} data-testid="input-leaf-window" />
            </label>
            <button type="button" className="control-button" onClick={() => setWin(Math.min(maxWin, w0 + 1))} disabled={w0 >= maxWin} aria-label="Next 50 leaves" data-testid="button-leaves-next"><ChevronRight size={13} /></button>
          </div>
          <div className="sim-leafgrid" role="group" aria-label="Leaves in this window; select one to inspect its proof">
            {leaves.map((r) => (
              <button key={r.index} type="button" className={`sim-leaf ${selected === r.index ? "sim-leaf-on" : ""}`}
                aria-pressed={selected === r.index} onClick={() => onSelect(r.index)}
                title={`#${r.index} ${r.trace.agent_id}: ${r.trace.thought}`}
                aria-label={`Leaf ${r.index}, ${r.trace.agent_id}: ${r.trace.thought}`} data-testid={`leaf-node-${r.index}`}>
                {r.index}
              </button>
            ))}
          </div>
        </div>
      )}
      {pathHashes.length > 0 && (
        <ol className="sim-chain" aria-label="Inclusion path from leaf to root">
          <li><b>leaf #{selected}</b><code>0x00 || preimage</code></li>
          {pathHashes.map((h, i) => (<li key={i}><b>sibling {i + 1}</b><code>{short(h)}</code></li>))}
          <li className="sim-chain-root"><b>current root</b><code>{short(root)}</code></li>
        </ol>
      )}
    </figure>
  );
}
