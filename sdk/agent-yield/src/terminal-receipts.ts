// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.

/** Observer only: console failures must never affect payments or claims. */
export function terminalReceipt(
  kind: "allocated" | "settled",
  amountMsats: string,
): void {
  try {
    if (process.env.QUIET_STRATIGRAPHY?.toLowerCase() === "true") return;
    if (!/^\d+$/.test(amountMsats)) return;
    const amount = BigInt(amountMsats);
    if (amount <= 0n) return;
    const fraction = (amount % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
    const sats = `${amount / 1000n}${fraction ? `.${fraction}` : ""}`;
    const color = kind === "settled" ? "\x1b[32m" : "\x1b[33m";
    const message = kind === "settled"
      ? `Thermodynamic Yield Earned: ${sats} Sats routed to agent wallet.`
      : `Thermodynamic Yield Allocated: ${sats} Sats (settlement pending).`;
    // stderr keeps stdout usable for MCP/JSON protocols; no keys or proofs.
    console.error(`${color}[Bitcoin Stratigraphy] ⚡ ${message}\x1b[0m`);
  } catch { /* Logging is best effort, never a payment dependency. */ }
}
