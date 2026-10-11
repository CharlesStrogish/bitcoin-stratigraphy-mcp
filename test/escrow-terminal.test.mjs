import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = "../artifacts/bitcoin-stratigraphy-dashboard/src/simulator/";
const read = (file) => readFileSync(new URL(root + file, import.meta.url), "utf8");
const jsx = (type, props) => ({ type, props });

function compile(source, require, extra = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText, {
    exports, require, AbortController, DOMException, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, ...extra,
  });
  return exports;
}

const quote = (fee = 2, source = "market") => ({
  toll_fee_sats: fee, target_usd: 0.02, btc_usd_price: source === "market" ? 1_000_000 : null,
  source, quoted_at: new Date().toISOString(),
});
const helper = compile(read("engine/escrowToll.ts"), (path) => {
  assert.equal(path, "@workspace/api-client-react");
  return { getEscrowToll: async () => quote() };
});

test("browser evaluates quoted fee and fails safely to 21 on offline or invalid responses", async () => {
  const signal = new AbortController().signal;
  assert.equal((await helper.evaluateEscrowToll(signal)).toll_fee_sats, 2);
  assert.equal((await helper.evaluateEscrowToll(signal, async () => {
    throw new Error("offline");
  })).toll_fee_sats, 21);
  for (const fee of [0, -1, NaN, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await helper.evaluateEscrowToll(signal, async () => quote(fee))).toll_fee_sats, 21);
  }
  assert.equal(
    (await helper.evaluateEscrowToll(signal, async () => quote(2, "fallback"))).toll_fee_sats, 21,
  );
  assert.equal((await helper.evaluateEscrowToll(signal, async () => quote(1))).toll_fee_sats, 1);
});

test("cancelled browser quote does not silently continue a settlement simulation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(helper.evaluateEscrowToll(controller.signal), /aborted/);
  const running = new AbortController();
  await assert.rejects(helper.evaluateEscrowToll(running.signal, async () => {
    running.abort();
    return quote();
  }), /aborted/);
});

function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (!node || typeof node !== "object") return;
  visit(node);
  walk(node.props?.children, visit);
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node === undefined || node === null || typeof node === "boolean") return "";
  return typeof node === "object" ? text(node.props?.children) : String(node);
}

function harness(evaluate) {
  const values = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (next) => {
        values[index] = typeof next === "function" ? next(values[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useEffect() {},
  };
  const { EscrowTerminal } = compile(read("components/EscrowTerminal.tsx"), (path) => {
    if (path === "react") return react;
    if (path === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (path === "lucide-react") return { Play: "icon" };
    if (path === "./CopyJsonButton") return { CopyJsonButton: "copy" };
    if (path === "../engine/escrowToll") return { evaluateEscrowToll: evaluate };
    if (path.endsWith(".css")) return {};
    throw new Error(`Unexpected import: ${path}`);
  }, { crypto: webcrypto, window: {
    setTimeout: (callback) => setTimeout(callback, 0), clearTimeout,
  } });
  const render = () => { cursor = 0; return EscrowTerminal(); };
  const find = (tree, id) => {
    let found;
    walk(tree, (node) => { if (node.props["data-testid"] === id) found = node; });
    return found;
  };
  return { render, find };
}

test("each simulation binds its dynamic fee into step 3, copied JSON and exact session total", async () => {
  const fees = [2, 13, 21, Number.MAX_SAFE_INTEGER];
  let index = 0;
  const h = harness(async () => quote(fees[index++], index === 3 ? "fallback" : "market"));
  let total = 0n;
  for (const fee of fees) {
    const tree = h.render();
    await h.find(tree, "button-simulate-settlement").props.onClick();
    const completed = h.render();
    total += BigInt(fee);
    assert.match(text(h.find(completed, "metric-tolls")), new RegExp(`${total} sats`));
    assert.ok(text(h.find(completed, "stage-3")).includes(`Collects ${fee} Sats Toll`));
    const receipt = JSON.parse(h.find(completed, "text-escrow-proof").props.children);
    assert.equal(receipt.tollSats, fee);
    assert.equal(receipt.pricing.toll_fee_sats, fee);
    assert.equal(receipt.simulated, true);
    let copy;
    walk(completed, (node) => { if (node.type === "copy") copy = node; });
    assert.equal(copy.props.text, h.find(completed, "text-escrow-proof").props.children);
  }
  assert.equal(index, fees.length);
});

test("rapid repeated clicks cannot double count a pending quote or simulation", async () => {
  let release;
  let calls = 0;
  const h = harness(() => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  });
  const start = h.find(h.render(), "button-simulate-settlement").props.onClick;
  const first = start();
  await start();
  assert.equal(calls, 1);
  release(quote(2));
  await first;
  assert.match(text(h.find(h.render(), "metric-tolls")), /2 sats/);
});
