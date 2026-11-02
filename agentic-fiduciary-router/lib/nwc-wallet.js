const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function createNwcWallet(uri, timeoutMs) {
  let parsed;
  try { parsed = new URL(uri); } catch { throw new Error("INVALID_NWC_URI"); }
  if (parsed.protocol !== "nostr+walletconnect:" ||
      !/^[0-9a-f]{64}$/i.test(parsed.hostname) ||
      !/^[0-9a-f]{64}$/i.test(parsed.searchParams.get("secret") ?? "") ||
      !parsed.searchParams.getAll("relay").length ||
      parsed.searchParams.getAll("relay").some(relay => {
        try { const url = new URL(relay); return url.protocol !== "wss:" || !!url.username || !!url.password; }
        catch { return true; }
      })) throw new Error("INVALID_NWC_URI");

  async function invoke(method, args) {
    let client, timer;
    try {
      const { NWCClient } = await import("@getalby/sdk");
      client = new NWCClient({ nostrWalletConnectUrl: uri, logger: silentLogger });
      return await Promise.race([
        client[method](args),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("NWC_TIMEOUT")), timeoutMs); }),
      ]);
    } catch {
      // Provider exceptions may contain connection secrets. Never propagate them.
      throw new Error("NWC_OUTCOME_UNCERTAIN");
    } finally {
      clearTimeout(timer);
      try { client?.close(); } catch { /* Does not change settlement evidence. */ }
    }
  }
  return {
    payInvoice: invoice => invoke("payInvoice", { invoice }),
    makeInvoice: amount => invoke("makeInvoice", {
      amount, description: "Bitcoin Stratigraphy private yield withdrawal", expiry: 3600,
    }),
  };
}
