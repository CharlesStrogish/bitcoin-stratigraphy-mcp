/** Keep useful wallet error reasons, never raw error objects or connection secrets. */
export function nwcErrorReason(error: unknown, uri?: string): string {
  const secrets = [uri, process.env.NOSTR_PRIVATE_KEY, process.env.NOSTR_SERVER_PRIVKEY,
    process.env.NWC_URI, process.env.NWC_PAIRING_SECRET, process.env.ALBY_NWC_URI,
    process.env.NWC_FALLBACK_URI].filter((value): value is string => !!value);
  for (const value of [...secrets]) {
    try {
      const url = new URL(value);
      for (const credential of url.searchParams.values()) {
        if (credential.length >= 8) secrets.push(credential);
      }
    } catch { /* A standalone key is not a URL. */ }
  }
  const redact = (text: string) => {
    for (const secret of secrets.sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join("[REDACTED]");
    }
    return text
      .replace(/(?:nostr\+walletconnect|nostrwalletconnect|wss?|https?):\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
      .replace(/\bnsec1[0-9a-z]+\b/gi, "[REDACTED_KEY]")
      .replace(/\b[0-9a-f]{64}\b/gi, "[REDACTED_KEY]")
      .replace(/((?:secret|token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/[\r\n\t]/g, " ");
  };
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current) && seen.size < 4) {
    seen.add(current);
    if (typeof current === "string") { parts.push(redact(current)); break; }
    if (typeof current !== "object") break;
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown; status?: unknown; statusCode?: unknown };
    const fields = [value.name, value.code, value.status ?? value.statusCode, value.message]
      .filter((field) => typeof field === "string" || typeof field === "number");
    if (fields.length) parts.push(redact(fields.join(": ")));
    current = value.cause;
  }
  return (parts.join("; caused by ") || "Unknown NWC provider failure").slice(0, 2000);
}
