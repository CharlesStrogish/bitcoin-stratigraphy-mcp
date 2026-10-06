// Canonical JSON matching Python: json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False, allow_nan=False)
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function cmpCodePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export function canonicalJson(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error("Only safe integers are permitted in simulated traces");
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(cmpCodePoints);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("Hex must be canonical lowercase");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
