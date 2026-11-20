import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** An isolated Chromium instance; never attaches to the workspace preview browser. */
export async function launchAuditBrowser() {
  const executable = process.env.SITE_AUDIT_CHROMIUM ?? "/repl/tools/bin/chromium";
  if (!existsSync(executable)) throw new Error("Site audit requires Chromium; set SITE_AUDIT_CHROMIUM to its executable.");
  const profile = mkdtempSync(path.join(tmpdir(), "site-integrity-chromium-"));
  const child = spawn(executable, [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu", "--no-first-run", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });
  let socket;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let attempt = 0; !existsSync(portFile) && attempt < 150; attempt++) await delay(100);
    if (!existsSync(portFile)) throw new Error("Audit Chromium did not start within 15 seconds");
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((item) => item.type === "page");
    if (!target) throw new Error("Audit Chromium has no page target");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id);
        if (entry) { pending.delete(data.id); clearTimeout(entry.timer); data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result); }
      } else if (data.method === "Runtime.exceptionThrown") {
        errors.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
      } else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
        errors.push(data.params.args.map((arg) => arg.value ?? arg.description).join(" "));
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const number = ++id;
      const timer = setTimeout(() => { pending.delete(number); reject(new Error(`Chromium timed out: ${method}`)); }, 20_000);
      pending.set(number, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: number, method, params }));
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.__auditCopies = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async value => { window.__auditCopies.push(String(value)); }
      }});
      // Offline fixtures exercise the generic explorer without contacting any
      // backend, creating invoices, or sending analytics. Cookbook GETs are local.
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, options = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.origin === location.origin && url.pathname.startsWith("/cookbooks/"))
          return originalFetch(input, options);
        if (url.pathname === "/api/healthz")
          return Promise.resolve(new Response(JSON.stringify({status:"ok"}), {headers:{"content-type":"application/json"}}));
        if (url.pathname === "/mcp" && JSON.parse(options.body || "{}").method === "tools/list")
          return Promise.resolve(new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{tools:[{
            name:"stratigraphy.list",description:"Offline read-only catalog fixture",
            inputSchema:{type:"object",properties:{},additionalProperties:false}
          }]}}), {headers:{"content-type":"application/json"}}));
        return new Promise(() => {});
      };
    ` });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    const waitForPage = async (url) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete" && !!document.querySelector("h1")`)) return;
        await delay(100);
      }
      throw new Error(`Navigation did not finish: ${url}`);
    };
    return {
      async checkAnchor(url, width = 1440, selector, hashchange = false) {
        await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
        await send("Page.navigate", { url });
        await waitForPage(url);
        if (selector) {
          const destination = await evaluate(`(() => {
            const link = document.querySelector(${JSON.stringify(selector)});
            if (!link) throw new Error("Missing navigation control");
            const href = link.href; link.click(); return href;
          })()`);
          await waitForPage(destination);
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate(`!location.hash || !!document.getElementById(decodeURIComponent(location.hash.slice(1)))`)) break;
          await delay(20);
        }
        if (hashchange) await evaluate(`(() => {
          const hash = location.hash;
          history.replaceState(null, "", location.pathname + location.search);
          window.scrollTo({top:0,behavior:"instant"});
          location.hash = hash;
        })()`);
        await delay(900);
        return evaluate(`(() => {
          const id = decodeURIComponent(location.hash.slice(1));
          const target = document.getElementById(id);
          const bounds = target?.getBoundingClientRect();
          return {pathname:location.pathname,hash:location.hash,scrollY,
            top:bounds?.top,bottom:bounds?.bottom,height:innerHeight,
            headerBottom:Math.max(0,document.querySelector(".fn-nav")?.getBoundingClientRect().bottom || 0),
            tiers:target?.querySelectorAll('[data-testid^="radio-waiver-"]').length,
            checkout:target?.matches('[data-testid="panel-waiver-purchase"]'),
            licenseeTop:target?.querySelector('[data-testid="input-licensee-name"]')?.getBoundingClientRect().top,
            licensee:!!target?.querySelector('[data-testid="input-licensee-name"]'),
            identifier:!!target?.querySelector('[data-testid="input-licensee-identifier"]')};
        })()`);
      },
      async inspect(url, width = 1440) {
        errors.length = 0;
        await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
        await send("Page.navigate", { url });
        for (let attempt = 0; attempt < 150; attempt++) {
          if (await evaluate(`document.readyState === "complete" && document.querySelector("h1") !== null`)) break;
          await delay(100);
        }
        const result = await evaluate(`(async () => {
          const copies = [], variants = [];
          async function captureCopies() {
          for (const button of document.querySelectorAll("button")) {
            const label = button.getAttribute("aria-label") || button.textContent.trim();
            if (!/^copy\\b/i.test(label) || button.disabled || !button.getClientRects().length) continue;
            const start = window.__auditCopies.length;
            button.click();
            for (let attempt=0; window.__auditCopies.length===start && attempt<30; attempt++)
              await new Promise(resolve=>setTimeout(resolve,20));
            const sourcePath = button.closest(".cook")?.querySelector("code")?.textContent || "";
            copies.push({label, sourcePath, values: window.__auditCopies.slice(start)});
          }
          }
          await captureCopies();
          for (const tab of document.querySelectorAll('[role="tab"]')) {
            if (tab.disabled || !tab.getClientRects().length) continue;
            tab.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (document.querySelector("#rest-run")?.getClientRects().length) {
              document.querySelector("#rest-ep").value="/api/healthz";
              document.querySelector("#rest-run").click();
              await new Promise(resolve=>setTimeout(resolve,50));
            }
            await captureCopies();
            variants.push(document.documentElement.outerHTML);
          }
          return {html:document.documentElement.outerHTML, copies,
            variants,
            width:innerWidth, scrollWidth:document.documentElement.scrollWidth,
            headings:[...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(e=>({level:Number(e.tagName[1]),title:e.textContent.trim()}))};
        })()`);
        return { ...result, errors: [...errors] };
      },
      async close() {
        socket.close();
        child.kill("SIGTERM");
        for (let i = 0; child.exitCode === null && i < 40; i++) await delay(50);
        if (child.exitCode === null) child.kill("SIGKILL");
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  } catch (error) {
    socket?.close();
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}
