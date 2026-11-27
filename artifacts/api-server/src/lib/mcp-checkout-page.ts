import { AS_IS_TERMS } from "./as-is-terms";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

/** Static landing page: GET never reads a checkout, quotes a price or derives an address. */
export function checkoutHandoffHtml(nonce: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Verified checkout handoff · Bitcoin Stratigraphy</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:hsl(222 34% 12%);--card:hsl(220 29% 15%);--fg:hsl(38 34% 92%);--muted:hsl(220 12% 70%);--border:hsl(220 24% 26%);--input:hsl(220 24% 36%);--primary:hsl(42 96% 57%);--primary-h:hsl(42 96% 64%);--on-primary:hsl(222 34% 12%);--accent:hsl(13 58% 60%);--danger:hsl(3 80% 76%);--teal:hsl(164 33% 52%);--mono:"DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--sans:"Space Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100dvh;background:radial-gradient(circle at 15% 0%,hsl(40 82% 47% / .12),transparent 28rem),var(--bg);color:var(--fg);font:16px/1.6 var(--sans);overflow-wrap:anywhere}
main{max-width:720px;padding:32px 20px 48px;margin:auto}
main>a:first-child{display:inline-flex;align-items:center;gap:9px;min-height:44px;font:500 11px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;text-decoration:none}
main>a:first-child::before{content:"";width:28px;height:1px;background:currentColor}
h1{font-size:clamp(28px,6vw,42px);line-height:1.05;letter-spacing:-.05em;font-weight:600;margin:10px 0 14px}
h2{font-size:20px;line-height:1.2;letter-spacing:-.035em;margin:0 0 6px;font-weight:600}h3{font-size:16px;margin:20px 0 8px}
a{color:var(--primary);text-underline-offset:3px}a:hover{color:var(--primary-h)}
section{background:var(--card);border:1px solid var(--border);border-top:2px solid var(--primary);border-radius:8px;padding:22px;margin:22px 0;min-width:0}
label{display:block;margin:18px 0 6px;font-weight:500}
label:has(input[type=checkbox]){display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-weight:400}
input[type=checkbox]{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:var(--primary)}
input,select,button{font:inherit;max-width:100%}
input:not([type=checkbox]),select{display:block;width:100%;min-height:44px;padding:10px 12px;background:var(--bg);color:inherit;border:1px solid var(--input);border-radius:6px;font-family:var(--mono);font-size:15px;transition:border-color .15s ease}
input:not([type=checkbox]):hover,select:hover{border-color:var(--muted)}
input:user-invalid{border-color:var(--danger)}
button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:11px 18px;background:var(--primary);color:var(--on-primary);border:1px solid transparent;border-radius:6px;font-weight:600;cursor:pointer;margin:16px 8px 0 0;text-align:center;white-space:normal;transition:transform .15s ease,background-color .15s ease,border-color .15s ease}
button:hover:not(:disabled){background:var(--primary-h);transform:translateY(-1px)}button:active:not(:disabled){transform:translateY(0)}
button:disabled{opacity:.55;cursor:wait}
.secondary{background:transparent;color:var(--fg);border-color:var(--input)}.secondary:hover:not(:disabled){background:hsl(220 24% 20%);border-color:var(--primary)}
:focus-visible{outline:2px solid var(--primary);outline-offset:3px;border-radius:4px}
input:focus-visible,select:focus-visible{outline-offset:1px;border-color:var(--primary)}
#stripe-link:not([hidden]){display:inline-flex;align-items:center;min-height:44px;padding:10px 14px;border:1px solid var(--teal);border-radius:6px;color:var(--fg);font-weight:600;text-decoration:none}
#stripe-link:hover{background:hsl(164 33% 45% / .14)}
details{margin:20px 0 4px;border:1px solid var(--border);border-radius:6px;background:hsl(222 34% 12% / .6)}
summary{cursor:pointer;padding:12px 14px;min-height:44px;color:var(--primary);font-weight:600}
details pre{margin:0;padding:0 14px 14px;border-top:1px solid var(--border);padding-top:12px}
pre,output{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
pre{max-height:420px;overflow:auto;font:13px/1.55 var(--mono);max-width:100%}
#quote-details:not(:empty),#certificate{padding:14px;background:var(--bg);border:1px solid var(--border);border-radius:6px}
#certificate{border-color:var(--teal);border-left-width:3px}
#status{margin:22px 0 6px;padding:10px 14px;border-left:2px solid var(--primary);background:hsl(42 96% 57% / .06);font:14px/1.55 var(--mono)}
.muted{color:var(--muted);font-size:14.5px}.error{color:var(--danger);font-weight:500}
.error:not(:empty){padding:10px 14px;border:1px solid hsl(3 64% 57% / .6);border-left-width:3px;border-radius:6px;background:hsl(3 64% 57% / .09)}
small{display:block;color:var(--muted);font-size:13.5px;line-height:1.5;margin-top:6px}
[hidden]{display:none!important}
@media (max-width:520px){main{padding:22px 14px 40px}section{padding:18px 14px}button{width:100%;margin-right:0}}
@media (prefers-reduced-motion:reduce){*,*::before{transition:none!important;animation:none!important}button:hover:not(:disabled){transform:none}}
@media (forced-colors:active){button,section,input,select{border:1px solid CanvasText}}
</style></head><body><main>
<a href="/#enterprise-licensing">Bitcoin Stratigraphy · Enterprise licensing</a>
<h1>Verified checkout handoff</h1>
<p>No purchase or Bitcoin address has been created by opening this page.</p>
<p class="muted">Prove the same caller ownership before continuing. The handoff ID alone grants no access.
Never enter an API key, wallet secret, macaroon or payment preimage here.</p>
<section id="pair"><h2>Connect to your agent</h2>
<form id="connect"><label for="owner">Separate 256-bit caller pairing key</label>
<input id="owner" type="password" autocomplete="off" spellcheck="false" aria-describedby="pair-help">
<small id="pair-help">Use the random X-MCP-Owner-Key your agent generated, sent separately from this URL.</small>
<label><input id="nostr" type="checkbox"> Use my Nostr browser signer instead</label>
<small>The signer must control the same public key as the requesting agent. No private key is shared.</small>
<button type="submit">Verify handoff</button></form></section>
<p id="status" role="status">Waiting for owner verification.</p>
<p id="error" role="alert" class="error"></p>
<section id="scanner" hidden><h2>Scanner Pack checkout</h2>
<p>Review current pricing and scope on the <a href="/#enterprise-licensing" target="_blank" rel="noopener noreferrer">enterprise licensing page</a>.
Scanner credits do not authorize paid MCP tools.</p>
<button id="start-scanner">Prepare Stripe checkout</button>
<p><a id="stripe-link" target="_blank" rel="noopener noreferrer" hidden>Open secure Stripe Checkout in a new tab</a></p>
<button id="recover-scanner" class="secondary">Check or recover existing purchase</button>
<p class="muted">Keep this page open. Completion is recorded only after the original server verifies fulfillment.
An uncertain purchase must be recovered, never paid a second time.</p></section>
<section id="waiver" hidden><h2>Self-serve AGPLv3 waiver</h2>
<form id="quote-form"><label for="tier">License tier</label><select id="tier">
<option value="swarm_monthly">Swarm monthly</option><option value="swarm_annual">Swarm annual</option>
<option value="global_monthly">Global monthly</option><option value="global_annual">Global annual</option></select>
<label for="licensee-name">Licensee name</label><input id="licensee-name" maxlength="200" required>
<label for="licensee-id">Licensee identifier</label><input id="licensee-id" maxlength="200" required>
<details><summary>Read the existing AS-IS commercial terms</summary><pre>${escapeHtml(AS_IS_TERMS)}</pre></details>
<label><input id="terms" type="checkbox" required> I accept the existing commercial terms.</label>
<button type="submit">Create one payment quote</button></form>
<div id="quote"><h3>Claim or recover the same quote</h3><pre id="quote-details"></pre>
<form id="claim-form"><label for="quote-id">Existing quote ID</label><input id="quote-id" pattern="[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}" required>
<label for="txid">Payment transaction ID</label><input id="txid" pattern="[0-9a-fA-F]{64}" required>
<button type="submit">Verify payment and claim waiver</button></form></div>
<p class="muted">Only the explicit quote action allocates an address. Do not create another quote to check confirmations.
The handoff expires after 15 minutes; the original quote and purchase retain their own recovery rules.</p></section>
<pre id="certificate" hidden></pre>
<p class="muted">Finite HTTP transport: the agent polls its owner-bound status endpoint, then retries with the same
requestState. Completion is correlation only, not a payment credential or paid-tool authorization.</p>
</main><script nonce="${nonce}">${checkoutClient}</script></body></html>`;
}

// No dynamic query values are interpolated into executable HTML.
const checkoutClient = String.raw`
(() => {
  const el = id => document.getElementById(id);
  const id = new URLSearchParams(location.search).get("handoff");
  let verified = false, quote, timer, expiresAt = 0, busy = false;
  const showError = error => { el("error").textContent = error.message || "Request unavailable; preserve any existing purchase."; };
  const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");
  async function request(path, method = "GET", body, correlate = false) {
    const headers = { Accept: "application/json" };
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined) headers["Content-Type"] = "application/json";
    if (correlate) headers["X-MCP-Elicitation-Id"] = id;
    if (el("nostr").checked) {
      if (!window.nostr) throw Error("A Nostr browser signer is required.");
      const tags = [["u", location.origin + path], ["method", method]];
      if (serialized !== undefined) tags.push(["payload", hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)))]);
      const event = await window.nostr.signEvent({ kind:27235, created_at:Math.floor(Date.now()/1000), tags, content:"" });
      headers["X-Nostr-Authorization"] = "Nostr " + btoa(JSON.stringify(event));
    } else headers["X-MCP-Owner-Key"] = el("owner").value.trim();
    const response = await fetch(path, { method, headers, body:serialized, credentials:"same-origin", cache:"no-store", redirect:"error" });
    const data = await response.json();
    if (!response.ok) throw Error(typeof data.error === "string" ? data.error : "Checkout unavailable; recover any existing purchase.");
    return data;
  }
  async function status() {
    const data = await request("/api/v1/mcp/elicitation/" + encodeURIComponent(id));
    expiresAt = data.expiresAt;
    el("status").textContent = data.status === "completed" ? "Verified checkout completed. Your agent can now poll and retry." :
      "Owner verified · " + data.intent + " · expires " + new Date(expiresAt).toLocaleTimeString();
    if (data.status === "completed") {
      clearInterval(timer);
      el("scanner").hidden = el("waiver").hidden = true;
    }
    return data;
  }
  async function run(action) {
    if (busy) return;
    busy = true; el("error").textContent = "";
    document.querySelectorAll("button").forEach(button => button.disabled = true);
    try { await action(); } catch (error) { showError(error); }
    finally { busy = false; document.querySelectorAll("button").forEach(button => button.disabled = false); }
  }
  async function recoverScanner() {
    if (Date.now() >= expiresAt) { clearInterval(timer); throw Error("Handoff expired. Keep and recover the existing purchase directly; do not pay again."); }
    await request("/api/fiat-mint/status", "POST", {}, true);
    await status();
  }
  el("connect").addEventListener("submit", event => { event.preventDefault(); void run(async () => {
    const data = await status();
    verified = true;
    el("scanner").hidden = data.intent !== "scanner_pack_checkout" || data.status !== "pending";
    el("waiver").hidden = data.intent !== "agpl_waiver_checkout" || data.status !== "pending";
  }); });
  el("start-scanner").addEventListener("click", () => void run(async () => {
    if (!verified) return;
    const data = await request("/api/fiat-mint", "POST", {}, true);
    const url = new URL(data.url);
    if (url.origin !== "https://checkout.stripe.com") throw Error("Unexpected checkout URL; do not proceed.");
    el("stripe-link").href = url.href; el("stripe-link").hidden = false;
    clearInterval(timer);
    timer = setInterval(() => { if (!busy) void run(recoverScanner); }, 5000);
  }));
  el("recover-scanner").addEventListener("click", () => void run(recoverScanner));
  el("quote-form").addEventListener("submit", event => { event.preventDefault(); void run(async () => {
    if (!verified) return;
    quote = await request("/api/v1/waivers/quote", "POST", {
      tier:el("tier").value, licensee_name:el("licensee-name").value,
      licensee_identifier:el("licensee-id").value, terms_accepted:el("terms").checked
    }, true);
    el("quote-details").textContent = JSON.stringify(quote, null, 2);
    el("quote-id").value = quote.quote_id;
    el("quote-form").hidden = true; el("quote").hidden = false;
  }); });
  el("claim-form").addEventListener("submit", event => { event.preventDefault(); void run(async () => {
    if (!verified) return;
    const certificate = await request("/api/v1/waivers/claim", "POST", { quote_id:el("quote-id").value.trim(), txid:el("txid").value.trim() }, true);
    el("certificate").textContent = JSON.stringify(certificate, null, 2);
    el("certificate").hidden = false;
    await status();
  }); });
  window.addEventListener("pagehide", () => clearInterval(timer));
})();`;
