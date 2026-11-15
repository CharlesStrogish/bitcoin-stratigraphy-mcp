export type RecordStatus = "settled" | "pending" | "rejected";

export interface FlightRecord {
  id: string;
  agent: string;
  framework: string;
  action: string;
  proofHash: string;
  timestamp: string;
  status: RecordStatus;
  sats: number;
}

const AGENTS = ["kestrel-07", "marlin-12", "osprey-03", "tern-21", "heron-44", "plover-09", "skua-16"];
const FRAMEWORKS = ["LangGraph", "CrewAI", "AutoGen", "Swarm", "Semantic Kernel"];
const ACTIONS = [
  "tool.call:sql_readonly",
  "retrieval:policy_corpus",
  "handoff:planner->executor",
  "tool.call:http_get",
  "summarize:audit_window",
  "classify:risk_tier",
  "tool.call:vector_search",
  "sign:attestation_bundle",
];

// Deterministic PRNG (mulberry32) so fixtures are identical across reloads.
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(rng: () => number, n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}

export function makeRecord(rng: () => number, seq: number, at: Date): FlightRecord {
  const r = rng();
  const status: RecordStatus = r < 0.81 ? "settled" : r < 0.94 ? "pending" : "rejected";
  return {
    id: `DEMO-${String(seq).padStart(5, "0")}`,
    agent: AGENTS[Math.floor(rng() * AGENTS.length)],
    framework: FRAMEWORKS[Math.floor(rng() * FRAMEWORKS.length)],
    action: ACTIONS[Math.floor(rng() * ACTIONS.length)],
    proofHash: `0x${hex(rng, 64)}`,
    timestamp: at.toISOString(),
    status,
    sats: status === "rejected" ? 0 : 3 + Math.floor(rng() * 87),
  };
}

const BASE = Date.UTC(2025, 2, 14, 9, 41, 7);

export function buildFixtures(count = 36): FlightRecord[] {
  const rng = makeRng(1212);
  const out: FlightRecord[] = [];
  for (let i = 0; i < count; i++) {
    out.push(makeRecord(rng, 1000 + count - i, new Date(BASE - i * (17_000 + Math.floor(rng() * 40_000)))));
  }
  return out;
}

export const SIM_LIMIT = 40; // bounded live simulation: max extra sample records per session
