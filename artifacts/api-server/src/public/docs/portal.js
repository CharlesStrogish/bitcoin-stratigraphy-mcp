(function () {
  'use strict';
  var PROD = 'https://bitcoin-stratigraphy-dashboard.replit.app';
  var FREE = ['stratigraphy.list', 'proof.attenuate', 'payment.get_info', 'mesh.get_status'];
  var NS_COLOR = { stratigraphy: 'hsl(42 96% 57%)', proof: 'hsl(13 58% 62%)', mesh: 'hsl(164 33% 55%)', payment: 'hsl(220 18% 72%)' };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var state = { tools: [], selected: null, edits: {}, ctrl: null, last: null, auth: '' };

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    [].concat(kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function pretty(v) { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } }

  /* theme: only persisted item */
  var TK = 'bs-docs-theme';
  var theme = 'dark';
  try { theme = localStorage.getItem(TK) || localStorage.getItem('theme') || 'dark'; } catch (e) {}
  if (theme !== 'light') theme = 'dark';
  function applyTheme() { document.documentElement.setAttribute('data-theme', theme); }
  applyTheme();
  $('#theme-toggle').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark'; applyTheme();
    try { localStorage.setItem(TK, theme); } catch (e) {}
  });

  /* toast + copy */
  var toastT;
  function toast(msg, bad) {
    var t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = 'toast'; }, 2400);
  }
  function copyText(text, btn, label) {
    function done(ok) {
      toast(ok ? (label || 'Copied') + ' to clipboard' : 'Copy failed. Select the text and copy manually.', !ok);
      if (btn) {
        var old = btn.getAttribute('data-label') || btn.textContent; btn.setAttribute('data-label', old);
        btn.textContent = ok ? 'Copied' : 'Copy failed'; btn.classList.add(ok ? 'ok' : 'err');
        setTimeout(function () { btn.textContent = old; btn.classList.remove('ok', 'err'); }, 1600);
      }
    }
    function fallback() {
      var ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;top:0' }); ta.value = text;
      document.body.appendChild(ta); ta.select(); var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); done(ok);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  }
  document.querySelectorAll('[data-copy-text]').forEach(function (b) {
    b.addEventListener('click', function () { copyText(b.getAttribute('data-copy-text'), b, 'URL copied'); });
  });

  /* host */
  var here = location.origin, isProd = location.origin === PROD;
  $('#host-badge').textContent = isProd ? 'PRODUCTION' : 'PREVIEW / NON-PRODUCTION'; if (isProd) $('#host-badge').classList.add('prod');
  $('#host-note').textContent = 'Live tests below call ' + here + '/mcp (the current host), not necessarily production.';
  $('#q-here').textContent = here + '/mcp';
  $('#copy-here').addEventListener('click', function (e) { copyText(here + '/mcp', e.currentTarget, 'URL copied'); });

  /* tabs */
  var tabs = [].slice.call(document.querySelectorAll('#tabs [role=tab]'));
  function showTab(t) {
    tabs.forEach(function (x) {
      var on = x === t; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1;
      $('#' + x.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { showTab(t); });
    t.addEventListener('keydown', function (e) {
      var n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') n = (i + tabs.length - 1) % tabs.length;
      else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1;
      if (n >= 0) { e.preventDefault(); showTab(tabs[n]); tabs[n].focus(); }
    });
  });

  /* SSE / JSON parsing */
  function parseBody(text, ctype) {
    if (!text) return { kind: 'empty', value: null };
    var looksSse = /event-stream/i.test(ctype || '') || /^\s*(event|data|id|retry):/.test(text);
    if (looksSse) {
      var msgs = [];
      text.split(/\r?\n\r?\n/).forEach(function (blk) {
        var data = [];
        blk.split(/\r?\n/).forEach(function (l) { if (l.indexOf('data:') === 0) data.push(l.slice(5).replace(/^ /, '')); });
        if (data.length) { try { msgs.push(JSON.parse(data.join('\n'))); } catch (e) { msgs.push({ unparsed: data.join('\n') }); } }
      });
      var fin = null;
      msgs.forEach(function (m) { if (m && (m.result !== undefined || m.error !== undefined)) fin = m; });
      return { kind: 'sse', events: msgs, value: fin || msgs[msgs.length - 1] || null };
    }
    try { return { kind: 'json', value: JSON.parse(text) }; } catch (e) { return { kind: 'text', value: text }; }
  }

  async function timedFetch(url, opts, ms, trackPlayground) {
    var ctrl = new AbortController();
    if (trackPlayground) state.ctrl = ctrl;
    var timedOut = false, t = setTimeout(function () { timedOut = true; ctrl.abort(); }, ms || 30000);
    var t0 = performance.now();
    try {
      var r = await fetch(url, Object.assign({ credentials: 'omit', signal: ctrl.signal }, opts));
      var text = await r.text();
      return { ok: true, status: r.status, statusText: r.statusText, ms: Math.round(performance.now() - t0), text: text, headers: r.headers };
    } catch (e) {
      return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: timedOut ? 'Timed out after 30 s' : (e.name === 'AbortError' ? 'Cancelled' : (e.message || String(e))) };
    } finally { clearTimeout(t); if (state.ctrl === ctrl) state.ctrl = null; }
  }

  function mcpHeaders(withAuth) {
    var hd = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (withAuth && state.auth) hd.Authorization = state.auth;
    return hd;
  }

  /* schema helpers */
  function typeOf(s) {
    if (!s || typeof s !== 'object') return 'any';
    if (s.type) return Array.isArray(s.type) ? s.type.join(' | ') : (s.type === 'array' && s.items ? 'array<' + typeOf(s.items) + '>' : s.type);
    if (s.enum) return 'enum';
    var alt = s.anyOf || s.oneOf; if (alt) return alt.map(typeOf).join(' | ');
    if (s.allOf) return 'allOf'; if (s.$ref) return String(s.$ref).split('/').pop();
    return 'any';
  }
  function exampleFor(s) {
    if (!s || typeof s !== 'object') return null;
    if (s.examples && s.examples.length) return s.examples[0];
    if (s.example !== undefined) return s.example;
    if (s.default !== undefined) return s.default;
    if (s.enum && s.enum.length) return s.enum[0];
    if (s.const !== undefined) return s.const;
    var t = Array.isArray(s.type) ? s.type[0] : s.type;
    if (t === 'string') return s.format === 'date' ? '2025-01-01' : '';
    if (t === 'integer' || t === 'number') return s.minimum !== undefined ? s.minimum : 0;
    if (t === 'boolean') return false;
    if (t === 'array') return [];
    if (t === 'object') { var o = {}; (s.required || []).forEach(function (k) { o[k] = exampleFor((s.properties || {})[k]); }); return o; }
    var alt = s.anyOf || s.oneOf; if (alt && alt.length) return exampleFor(alt[0]);
    return null;
  }
  function seedArgs(tool) {
    var s = tool.inputSchema || {};
    if (tool.name === 'stratigraphy.list') return {};
    if (s.examples && s.examples.length && s.examples[0] && typeof s.examples[0] === 'object') return s.examples[0];
    var o = {}; (s.required || []).forEach(function (k) { o[k] = exampleFor((s.properties || {})[k]); });
    return o;
  }
  function isRisky(tool) {
    var a = tool.annotations || {};
    return a.destructiveHint === true || a.readOnlyHint === false;
  }
  function nsOf(n) { var i = n.indexOf('.'); return i > 0 ? n.slice(0, i) : 'other'; }

  /* load catalog */
  async function loadCatalog() {
    if (state.ctrl) { state.ctrl.abort(); state.ctrl = null; }
    saveEdit();
    $('#stats').innerHTML = '';
    $('#tool-list').replaceChildren(h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' }));
    $('#detail').replaceChildren(h('div', { class: 'panel pad' }, [h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' })]));
    var all = [], cursor = null, guard = 0;
    try {
      do {
        var req = { jsonrpc: '2.0', id: 'tools-list-' + (++guard), method: 'tools/list', params: cursor ? { cursor: cursor } : {} };
        var r = await timedFetch('/mcp', { method: 'POST', headers: mcpHeaders(false), body: JSON.stringify(req) });
        if (!r.ok) throw new Error(r.error);
        var p = parseBody(r.text, r.headers.get('content-type'));
        if (r.status >= 400 || !p.value || !p.value.result) {
          throw new Error('HTTP ' + r.status + ' ' + (p.value && p.value.error ? (p.value.error.message || pretty(p.value.error)) : String(r.text).slice(0, 200)));
        }
        all = all.concat(p.value.result.tools || []); cursor = p.value.result.nextCursor;
      } while (cursor && guard < 10);
    } catch (e) {
      $('#tool-list').replaceChildren();
      $('#detail').replaceChildren(h('div', { class: 'panel empty' }, [h('strong', { text: 'Could not load the live tool catalog' }), h('div', { text: e.message }), h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', type: 'button', onclick: loadCatalog, text: 'Retry' }))]));
      return;
    }
    state.tools = all.sort(function (a, b) { return a.name.localeCompare(b.name); });
    var nss = {}; all.forEach(function (t) { nss[nsOf(t.name)] = (nss[nsOf(t.name)] || 0) + 1; });
    var sel = $('#ns-filter'); sel.length = 1;
    Object.keys(nss).forEach(function (n) { sel.appendChild(h('option', { value: n, text: n + ' (' + nss[n] + ')' })); });
    var stats = $('#stats'); stats.appendChild(h('div', { class: 'stat' }, [h('b', { text: String(all.length) }), h('span', { text: 'live tools' })]));
    Object.keys(nss).forEach(function (n) { var s = h('div', { class: 'stat', style: '--c:' + (NS_COLOR[n] || 'inherit') }, [h('b', { text: String(nss[n]) }), h('span', { text: n })]); stats.appendChild(s); });
    if (!state.selected || !all.some(function (t) { return t.name === state.selected; })) selectTool(all.some(function (t) { return t.name === 'stratigraphy.list'; }) ? 'stratigraphy.list' : (all[0] && all[0].name), true);
    renderList(); renderDetail();
  }

  function renderList() {
    var q = $('#tool-search').value.trim().toLowerCase(), ns = $('#ns-filter').value, box = $('#tool-list'), groups = {};
    box.replaceChildren();
    state.tools.forEach(function (t) {
      var n = nsOf(t.name);
      if (ns && n !== ns) return;
      if (q && (t.name + ' ' + (t.description || '')).toLowerCase().indexOf(q) < 0) return;
      (groups[n] = groups[n] || []).push(t);
    });
    var keys = Object.keys(groups);
    if (!keys.length) { box.appendChild(h('div', { class: 'caption', style: 'padding:12px 2px;color:#e9e1d0', text: 'No tools match this search.' })); return; }
    keys.forEach(function (n) {
      box.appendChild(h('div', { class: 'ns', style: '--c:' + (NS_COLOR[n] || '#e9e1d0') }, [h('span', { text: n }), h('span', { text: String(groups[n].length) })]));
      groups[n].forEach(function (t) {
        var first = (t.description || '').split(/\n/)[0];
        box.appendChild(h('button', { type: 'button', class: 'tool-btn', role: 'option', 'aria-selected': String(t.name === state.selected), 'data-tool': t.name, onclick: function () { selectTool(t.name); } }, [t.name, h('small', { text: first })]));
      });
    });
  }
  $('#tool-search').addEventListener('input', renderList);
  $('#ns-filter').addEventListener('change', renderList);
  $('#reload').addEventListener('click', loadCatalog);

  function selectTool(name, silent) {
    if (state.ctrl) { state.ctrl.abort(); state.ctrl = null; }
    if (state.selected && state.selected !== name) saveEdit();
    state.selected = name; state.last = null;
    if (!silent) { renderList(); renderDetail(); }
  }
  function curTool() { return state.tools.filter(function (t) { return t.name === state.selected; })[0]; }
  function saveEdit() { var ta = $('#args-editor'); if (ta && state.selected) state.edits[ta.getAttribute('data-for')] = ta.value; }

  function codeBlock(text, cls) { return h('pre', { class: 'code ' + (cls || ''), tabindex: '0' }, text); }
  function copyBtn(label, getText, what) {
    return h('button', { class: 'btn sm', type: 'button', onclick: function (e) { copyText(getText(), e.currentTarget, what || label); }, text: label });
  }

  function paramTable(schema) {
    var props = (schema && schema.properties) || {}, req = (schema && schema.required) || [], keys = Object.keys(props);
    if (!keys.length) return h('div', { class: 'panel-body muted', text: 'This tool takes no parameters. Send an empty object.' });
    var body = h('tbody');
    keys.forEach(function (k) {
      var p = props[k] || {}, ex = p.examples && p.examples.length ? p.examples : (p.example !== undefined ? [p.example] : []);
      var extra = [];
      if (p.enum) extra.push('enum: ' + p.enum.join(', '));
      ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format'].forEach(function (c) { if (p[c] !== undefined) extra.push(c + ': ' + p[c]); });
      body.appendChild(h('tr', {}, [
        h('td', {}, h('code', { text: k })), h('td', {}, h('code', { text: typeOf(p) })),
        h('td', {}, req.indexOf(k) >= 0 ? h('span', { class: 'req', text: 'required' }) : h('span', { class: 'muted', text: 'optional' })),
        h('td', { text: (p.description || '') + (extra.length ? '  [' + extra.join('; ') + ']' : '') }),
        h('td', {}, [p.default !== undefined ? h('div', {}, ['default ', h('code', { text: JSON.stringify(p.default) })]) : null, ex.length ? h('div', {}, ['e.g. ', h('code', { text: JSON.stringify(ex[0]) })]) : null, (p.default === undefined && !ex.length) ? h('span', { class: 'muted', text: 'none' }) : null])
      ]));
    });
    return h('div', { class: 'table-scroll' }, h('table', {}, [h('thead', {}, h('tr', {}, ['Name', 'Type', 'Required', 'Description', 'Default / example'].map(function (x) { return h('th', { text: x }); }))), body]));
  }

  function renderDetail() {
    var t = curTool(), box = $('#detail');
    if (!t) { box.replaceChildren(h('div', { class: 'panel empty' }, [h('strong', { text: 'No tool selected' }), 'Pick a tool from the catalog.'])); return; }
    var free = FREE.indexOf(t.name) >= 0, risky = isRisky(t), a = t.annotations || {}, ns = nsOf(t.name);
    var tags = [h('span', { class: 'tag', style: 'color:' + (NS_COLOR[ns] || 'inherit'), text: ns }), h('span', { class: 'tag ' + (free ? 'free' : 'paid'), text: free ? 'free' : 'may require L402 payment' })];
    if (a.readOnlyHint === true) tags.push(h('span', { class: 'tag ro', text: 'read-only' }));
    if (a.destructiveHint === true) tags.push(h('span', { class: 'tag danger', text: 'destructive' }));
    else if (a.readOnlyHint === false) tags.push(h('span', { class: 'tag danger', text: 'writes state' }));
    if (a.idempotentHint === true) tags.push(h('span', { class: 'tag', text: 'idempotent' }));

    var head = h('div', { class: 'panel' }, [h('div', { class: 'panel-body' }, [h('div', { class: 'kicker', text: 'Tool' }), h('h2', { class: 'mono', text: t.name }), h('div', { class: 'tags' }, tags), h('p', { class: 'desc', text: t.description || 'No description provided by the server.' })])]);
    var params = h('div', { class: 'panel' }, [h('div', { class: 'panel-head' }, h('div', {}, [h('div', { class: 'kicker', text: 'Input' }), h('h3', { text: 'Parameters' })])), paramTable(t.inputSchema)]);

    var stored = state.edits[t.name]; if (stored === undefined) stored = pretty(seedArgs(t));
    var ta = h('textarea', { id: 'args-editor', 'data-for': t.name, rows: '9', spellcheck: 'false', 'aria-describedby': 'args-hint' }); ta.value = stored;
    ta.addEventListener('input', function () { state.edits[t.name] = ta.value; validate(); });
    var auth = h('input', { type: 'password', id: 'auth-in', autocomplete: 'off', placeholder: 'Bearer ... or L402 macaroon:preimage (optional)' }); auth.value = state.auth;
    auth.addEventListener('input', function () { state.auth = auth.value.trim(); });
    var ack = h('input', { type: 'checkbox', id: 'ack' }); ack.addEventListener('change', validate);
    var run = h('button', { class: 'btn primary', type: 'button', id: 'run', text: 'Run tools/call' });
    var cancel = h('button', { class: 'btn', type: 'button', id: 'cancel', text: 'Cancel', disabled: 'disabled' });
    var vmsg = h('div', { class: 'caption', id: 'args-hint', 'aria-live': 'polite' });
    var out = h('div', { id: 'pg-out' });

    function parseArgs() {
      var v; try { v = JSON.parse(ta.value || '{}'); } catch (e) { return { err: 'Invalid JSON: ' + e.message }; }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return { err: 'Arguments must be a JSON object.' };
      return { value: v };
    }
    function validate() {
      var p = parseArgs();
      vmsg.textContent = p.err ? p.err : 'Valid JSON object. The server performs canonical schema validation; this page does not fully validate against the schema.';
      vmsg.style.color = p.err ? 'hsl(var(--bad))' : '';
      run.disabled = !!p.err || (risky && !ack.checked) || !!state.ctrl;
    }
    function reqBody(args) { return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: args } }; }

    run.addEventListener('click', async function () {
      var p = parseArgs(); if (p.err) return;
      if (risky && !ack.checked) return;
      run.disabled = true; cancel.disabled = false; run.textContent = 'Running';
      out.replaceChildren(h('div', { class: 'result' }, [h('div', { class: 'panel-body' }, [h('div', { class: 'skel' }), h('div', { class: 'skel' })])]));
      var r = await timedFetch('/mcp', { method: 'POST', headers: mcpHeaders(true), body: JSON.stringify(reqBody(p.value)) }, 30000, true);
      if (state.selected !== t.name) return;
      cancel.disabled = true; run.textContent = 'Run tools/call'; validate();
      renderResult(out, r);
    });
    cancel.addEventListener('click', function () { if (state.ctrl) state.ctrl.abort(); });

    var curlBtn = copyBtn('Copy curl', function () {
      var p = parseArgs(); var args = p.value || {};
      return "curl -sS -X POST '" + here + "/mcp' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '" + JSON.stringify(reqBody(args)).replace(/'/g, "'\\''") + "'\n# add your own -H 'Authorization: ...' if required; not included here";
    }, 'curl copied');
    var reqBtn = copyBtn('Copy request JSON', function () { var p = parseArgs(); return pretty(reqBody(p.value || {})); }, 'Request JSON copied');
    var resetBtn = h('button', { class: 'btn sm', type: 'button', text: 'Reset to example', onclick: function () { ta.value = pretty(seedArgs(t)); state.edits[t.name] = ta.value; validate(); } });

    var pg = h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, h('div', {}, [h('div', { class: 'kicker', text: 'Live test' }), h('h3', { text: 'Playground' })])),
      h('div', { class: 'panel-body' }, [
        h('div', { class: 'callout' }, 'Calls POST ' + here + '/mcp on the current host' + (isProd ? ' (production).' : ' (not production).') + ' Nothing runs until you press the button.'),
        free ? null : h('div', { class: 'callout warn' }, [h('strong', { text: 'Paid tool. ' }), 'Calling without credentials may return HTTP 402 with a WWW-Authenticate challenge, and the challenge may create an invoice. This page never pays an invoice for you.']),
        h('label', { class: 'lbl', for: 'args-editor', text: 'Arguments (JSON object)' }), ta, vmsg,
        h('label', { class: 'lbl', for: 'auth-in', text: 'Authorization header (optional, memory only)' }), auth,
        h('div', { class: 'caption', text: 'Held in page memory, never stored, never placed in URLs, never copied into curl or request JSON. Requests omit cookies.' }),
        risky ? h('label', { class: 'check' }, [ack, h('span', { text: 'I understand this tool is annotated as non-read-only or destructive and may change server state.' })]) : null,
        h('div', { class: 'row' }, [run, cancel, resetBtn, reqBtn, curlBtn]),
        out
      ])
    ]);

    var sch = function (label, schema) {
      return h('details', {}, [h('summary', { text: label }), h('div', { class: 'row', style: 'margin:0 16px 8px' }, copyBtn('Copy schema', function () { return pretty(schema); }, 'Schema copied')), codeBlock(pretty(schema || {}), 'tall')]);
    };
    var schemas = h('div', { class: 'panel' }, [sch('Full input JSON schema', t.inputSchema), t.outputSchema ? sch('Full output JSON schema', t.outputSchema) : h('div', { class: 'panel-body muted', text: 'The server declares no output schema for this tool.' })]);
    box.replaceChildren(head, params, pg, schemas);
    validate();
  }

  function renderResult(out, r) {
    var p = r.ok ? parseBody(r.text, r.headers.get('content-type')) : null;
    var cls = r.status >= 500 || r.status === 0 ? 's5' : r.status >= 400 ? 's4' : 's2';
    var kids = [h('span', { class: 'st ' + cls, text: r.ok ? 'HTTP ' + r.status + ' ' + (r.statusText || '') : 'NETWORK ERROR' }), h('span', { text: r.ms + ' ms' })];
    if (p) kids.push(h('span', { text: 'format: ' + p.kind + (p.kind === 'sse' ? ' (' + p.events.length + ' events)' : '') }));
    var body = [];
    var clip = '';
    if (!r.ok) {
      body.push(h('div', { class: 'callout bad', text: r.error }));
      clip = r.error;
    } else {
      var wa = r.headers.get('www-authenticate');
      if (r.status === 402 || wa) {
        body.push(h('div', { class: 'callout warn' }, [h('strong', { text: 'WWW-Authenticate challenge' }), h('pre', { class: 'code wrap', style: 'margin-top:8px', text: wa || '(402 returned, header not readable by this origin)' }), h('div', { class: 'caption', style: 'margin-top:6px', text: 'Pay with your own wallet, then retry with the proof in the Authorization field. This page does not pay.' })]));
      }
      var v = p.value, isErr = v && (v.error || (v.result && v.result.isError));
      if (isErr || r.status >= 400) body.push(h('div', { class: 'callout bad', text: 'The call returned an error. The parsed body is shown unchanged below.' }));
      clip = pretty(v === null ? '' : v);
      if (p.kind === 'text') clip = r.text;
      body.push(h('div', { class: 'caption', text: 'Parsed body' }), codeBlock(clip || '(empty body)', 'tall'));
      if (p.kind === 'sse' && p.events.length > 1) body.push(h('details', {}, [h('summary', { text: 'All SSE data events' }), codeBlock(pretty(p.events))]));
      if (r.text && p.kind !== 'text') body.push(h('details', {}, [h('summary', { text: 'Raw response' }), codeBlock(r.text, 'wrap')]));
    }
    state.last = clip;
    out.replaceChildren(h('div', { class: 'result' }, [h('div', { class: 'result-head' }, kids.concat([copyBtn('Copy result', function () { return clip; }, 'Result copied')])), h('div', { class: 'panel-body' }, body)]));
  }

  /* REST */
  var restText = '';
  $('#rest-run').addEventListener('click', async function () {
    var ep = $('#rest-ep').value, out = $('#rest-out');
    if (['/api/healthz', '/api/readyz', '/openapi.json'].indexOf(ep) < 0) return;
    out.replaceChildren(h('div', { class: 'skel' }), h('div', { class: 'skel' }));
    var r = await timedFetch(ep, { method: 'GET', headers: { Accept: 'application/json' } });
    var box = h('div', {});
    if (!r.ok) { restText = r.error; renderResultInto(out, box, r, r.error); return; }
    var p = parseBody(r.text, r.headers.get('content-type'));
    restText = p.kind === 'text' ? r.text : pretty(p.value);
    renderResultInto(out, box, r, restText);
  });
  function renderResultInto(out, box, r, text) {
    var cls = r.status >= 500 || r.status === 0 ? 's5' : r.status >= 400 ? 's4' : 's2';
    out.replaceChildren(h('div', { class: 'result' }, [h('div', { class: 'result-head' }, [h('span', { class: 'st ' + cls, text: r.ok ? 'HTTP ' + r.status : 'NETWORK ERROR' }), h('span', { text: r.ms + ' ms' })]), h('div', { class: 'panel-body' }, codeBlock(text || '(empty body)', 'tall'))]));
  }
  $('#rest-copy').addEventListener('click', function (e) { if (!restText) return toast('Run a check first', true); copyText(restText, e.currentTarget, 'Result copied'); });

  /* Cookbooks */
  var COOKS = ['frameworks/langchain_agent.py', 'frameworks/llamaindex_agent.py', 'frameworks/README.md', 'frameworks/requirements-langchain.txt', 'frameworks/requirements-llamaindex.txt', 'l402_client.py', 'langchain_example.py', 'autogen_example.py', 'crewai_example.py', 'README.md', 'requirements.txt'];
  var cookText = '';
  var cl = $('#cook-list');
  COOKS.forEach(function (f) {
    var url = '/cookbooks/' + f;
    cl.appendChild(h('div', { class: 'cook' }, [h('code', { text: url }), h('div', { class: 'row', style: 'margin:0' }, [
      h('button', { class: 'btn sm', type: 'button', text: 'View', onclick: function () { loadCook(f); } }),
      h('button', { class: 'btn sm', type: 'button', text: 'Copy source', onclick: function (e) { fetchCook(f).then(function (t) { copyText(t, e.currentTarget, 'Source copied'); }, function (er) { toast('Could not fetch ' + f + ': ' + er.message, true); }); } }),
      h('a', { class: 'btn sm', href: url + '?download=1', text: 'Download' })])]));
  });
  async function fetchCook(f) {
    var r = await fetch('/cookbooks/' + f, { credentials: 'omit', headers: { Accept: 'text/plain' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  async function loadCook(f) {
    $('#cook-view').hidden = false; $('#cook-title').textContent = f; $('#cook-src').textContent = 'Loading...'; cookText = '';
    try { cookText = await fetchCook(f); $('#cook-src').textContent = cookText; }
    catch (e) { $('#cook-src').textContent = 'Could not load ' + f + ' (' + e.message + '). Use Download or try again.'; }
  }
  $('#cook-copy').addEventListener('click', function (e) { if (!cookText) return toast('No source loaded', true); copyText(cookText, e.currentTarget, 'Source copied'); });

  /* Mapping */
  var MAP = [
    ['get_latest', 'stratigraphy.get', 'Use days: 1.'],
    ['get_depth', 'stratigraphy.get', 'Query by date or blockHeight. It is not a depth metric.'],
    ['get_strata', 'stratigraphy.get_range', ''],
    ['search', 'Dashboard only (/)', 'Not an MCP tool.'],
    ['verify_zk_proof', 'proof.verify', ''],
    ['submit_attestation', 'proof.submit', ''],
    ['get_verification', 'proof.get_by_hash', ''],
    ['mesh status / get_peers', 'mesh.get_status', 'No independent peer tool.'],
    ['route_telemetry', 'mesh.broadcast', 'Broadcasts stored snapshots.'],
    ['quote_l402', 'payment.get_info', ''],
    ['verify_macaroon', 'Normal L402 authorization', 'No standalone tool.'],
    ['get_invoice', 'Paid 402 challenge', 'No standalone tool; the challenge carries the invoice.'],
    ['settle_test', 'Not offered', 'No fake or test settlement exists.']
  ];
  var mb = $('#map-table tbody');
  MAP.forEach(function (m) { mb.appendChild(h('tr', {}, [h('td', {}, h('code', { text: m[0] })), h('td', {}, h('code', { text: m[1] })), h('td', { text: m[2] })])); });

  loadCatalog();
})();
