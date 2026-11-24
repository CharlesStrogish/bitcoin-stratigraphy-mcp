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
      async checkAnchor(url, width = 1440, selector, hashchange = false, height = 1000) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
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
      async inspect(url, width = 1440, { height = 1000, responsive = false } = {}) {
        errors.length = 0;
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
        await send("Page.navigate", { url });
        await waitForPage(url);
        const layout = !responsive ? undefined : await evaluate(`(() => {
          const visible = e => {
            const r = e.getBoundingClientRect();
            const s = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility === "visible";
          };
          const box = e => {
            const r = e.getBoundingClientRect();
            return {width:Math.round(r.width),height:Math.round(r.height),left:Math.round(r.left),right:Math.round(r.right)};
          };
          const text = e => (e.textContent || "").trim().replace(/\\s+/g," ").slice(0,160);
          const els = selector => [...document.querySelectorAll(selector)].filter(visible);
          const contained = e => {
            for (let p=e.parentElement;p && p!==document.body;p=p.parentElement) {
              if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.clientWidth > 0) return true;
            }
            return false;
          };
          const subnav = els('.topbar nav[aria-label="Primary"] > .control-button, .topbar .header-actions:not(.homepage-actions) > :is(.control-button,.btn), .blog-nav > a, .cookbook-directory nav > .btn');
          const clipped = els('main a, main button, header a, header button, footer a, form input, pre, table, main .panel, main .card').filter(e => {
            const r = e.getBoundingClientRect();
            return (r.left < -2 || r.right > innerWidth + 2) && !contained(e);
          }).slice(0,18).map(e => ({tag:e.tagName,id:e.id,className:String(e.className),text:text(e),...box(e)}));
          const links = els('a[href]').map(e => ({href:e.getAttribute('href'),text:text(e)}));
          const images = els('img').filter(e => e.complete && !e.naturalWidth).map(e => e.currentSrc || e.getAttribute("src"));
          const disclosures = els('details > summary').map(e => {
            const detail = e.parentElement;
            const wasOpen = detail.open;
            e.click();
            const works = detail.open !== wasOpen;
            if (works) e.click();
            return {text:text(e),works};
          });
          const overflow = els('pre,table').filter(e => e.scrollWidth > e.clientWidth + 2 &&
            !/(auto|scroll)/.test(getComputedStyle(e).overflowX) && !contained(e)).map(e => ({tag:e.tagName,text:text(e),...box(e)}));
          const rgb = color => color.match(/^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*1)?\\)$/)?.slice(1).map(Number);
          const luminance = values => values.map(v => v/255).map(v => v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
            .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
          const gold = els('a,button:not([disabled])').flatMap(e => {
            const style = getComputedStyle(e);
            const bg=rgb(style.backgroundColor), fg=rgb(style.color);
            if (!bg || !fg || bg[0]<180 || bg[1]<100 || bg[0]<bg[1]*1.05 || bg[1]<bg[2]*1.5) return [];
            const values = [luminance(bg),luminance(fg)];
            return [{text:text(e),ratio:Math.round((Math.max(...values)+0.05)/(Math.min(...values)+0.05)*100)/100}];
          });
          const overlap = subnav.flatMap((e,i) => subnav.slice(i+1).flatMap(next => {
            const a=e.getBoundingClientRect(), b=next.getBoundingClientRect();
            return Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1
              ? [[text(e),text(next)]] : [];
          }));
          const rail = links.find(l => {
            const url = new URL(l.href, location.href);
            return ['https://bitcoinstratigraphy.com',location.origin].includes(url.origin) &&
              ((url.pathname==='/' && url.hash==='#enterprise-licensing') ||
               /^\\/(enterprise|audit|developers|docs)\\/?$/.test(url.pathname));
          });
          return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
            subnav:subnav.map(e=>({text:text(e),...box(e),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),
            clipped,overflow,rail,gold,overlap,images,disclosures,
            sales:links.filter(l=>/contact sales|enterprise sizing|book a demo|schedule a call|request a quote/i.test(l.text) ||
              /^mailto:.*(?:sales|licensing)@/i.test(l.href)),
            scanner:els('[data-testid="button-run-scan"]').map(text)};
        })()`);
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
        return { ...result, layout, errors: [...errors] };
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
