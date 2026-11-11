import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";

const source = readFileSync(
  new URL("../src/components/fiat-mint-checkout.tsx", import.meta.url),
  "utf8",
);

test("checkout clears its opening state even if navigation does not complete", () => {
  const checkout = source.slice(
    source.indexOf("async function checkout()"),
    source.indexOf("async function claim()"),
  );
  assert.match(
    checkout,
    /finally\s*\{\s*if \(alive\.current\) setBusy\(false\)/,
  );
  assert.match(checkout, /refresh\(\{ preserveError: true \}\)/);
  assert.match(source, /!preserveError \|\|/);
  assert.match(source, /signal: AbortSignal\.timeout\(25_000\)/);
});

const require = createRequire(import.meta.url);
const compiled = await transformWithEsbuild(source, "fiat-mint-checkout.tsx", {
  loader: "tsx",
  format: "cjs",
  jsx: "automatic",
});

// Exercise the actual component handlers with deterministic hooks and API doubles.
// No DOM package, live Stripe request, cookie, wallet or funded credential is used.
function mount() {
  const slots = [];
  const timers = new Map();
  let cursor = 0;
  let pendingEffects = [];
  let tree;
  let nextStatus = async () => ({ status: "checkout" });
  let nextClaim = async () => ({
    macaroon: "synthetic-invalid-test-credential",
    valid_until: 2_000_000_000,
  });
  const calls = { status: [], claim: 0, checkout: 0 };
  const onPendingChange = () => {};
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [
        slots[index].value,
        (value) => {
          slots[index].value =
            typeof value === "function" ? value(slots[index].value) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (
        !previous ||
        deps.some((value, i) => !Object.is(value, previous.deps[i]))
      ) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "setInterval",
    "clearInterval",
    compiled.code,
  )(
    (id) => {
      if (id === "react") return hooks;
      if (id === "@workspace/api-client-react")
        return {
          getFiatMintStatus(options) {
            calls.status.push(options);
            return nextStatus();
          },
          claimFiatMintMacaroon() {
            calls.claim++;
            return nextClaim();
          },
          createFiatMintCheckout() {
            calls.checkout++;
            throw new Error("Unexpected new purchase");
          },
        };
      return require(id);
    },
    module,
    module.exports,
    (callback) => {
      const id = Symbol();
      timers.set(id, callback);
      return id;
    },
    (id) => timers.delete(id),
  );
  function render() {
    cursor = 0;
    tree = module.exports.default({ onPendingChange });
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
  }
  function elements(node) {
    if (!React.isValidElement(node)) return [];
    return [
      node,
      ...React.Children.toArray(node.props.children).flatMap(elements),
    ];
  }
  const view = {
    calls,
    render,
    html: () => renderToStaticMarkup(tree),
    button: () =>
      elements(tree).find(
        (node) => node.props["data-testid"] === "button-card-check-original",
      ),
    reveal: () =>
      elements(tree).find(
        (node) =>
          node.type === "button" &&
          node.props.children === "Reveal funded Macaroon once",
      ),
    status: (handler) => {
      nextStatus = handler;
    },
    claim: (handler) => {
      nextClaim = handler;
    },
    poll: () => [...timers.values()].forEach((callback) => callback()),
    unmount: () => slots.forEach((slot) => slot.cleanup?.()),
    async settle() {
      await setImmediate();
      render();
      await setImmediate();
      render();
    },
  };
  render();
  return view;
}

test("manual recovery checks the original purchase, shows loading, and reports unpaid", async () => {
  const view = mount();
  await view.settle();
  let resolve;
  view.status(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  view.button().props.onClick();
  // Even a second click before React rerenders must not start another request.
  view.button().props.onClick();
  view.render();
  assert.equal(view.calls.status.length, 2);
  assert.equal(view.button().props.disabled, true);
  assert.equal(view.button().props["aria-busy"], true);
  assert.match(view.html(), /Checking original purchase/);
  assert.equal(view.calls.status[1].credentials, "same-origin");
  assert.equal(view.calls.status[1].cache, "no-store");
  resolve({ status: "checkout" });
  await view.settle();
  assert.equal(view.button().props.disabled, false);
  assert.match(
    view.html(),
    /role="alert"[^>]*>The original Stripe Checkout is still unpaid/,
  );
  assert.equal(view.calls.checkout, 0);
  assert.equal(view.calls.claim, 0);
  view.unmount();
});

test("manual recovery exposes network failures and permits another check", async () => {
  const view = mount();
  await view.settle();
  view.status(async () => {
    throw new Error("Unavailable");
  });
  view.button().props.onClick();
  await view.settle();
  assert.match(view.html(), /purchase recovery is unavailable/);
  assert.equal(view.button().props.disabled, false);
  view.status(async () => ({ status: "ready" }));
  view.button().props.onClick();
  await view.settle();
  assert.match(view.html(), /Funding verified/);
  assert.doesNotMatch(view.html(), /purchase recovery is unavailable/);
  assert.equal(
    view.calls.claim,
    0,
    "Recovery must not consume the one-time reveal",
  );
  view.reveal().props.onClick();
  await view.settle();
  assert.equal(view.calls.claim, 1);
  assert.match(view.html(), /synthetic-invalid-test-credential/);
  assert.match(view.html(), /Copy immediately/);
  assert.equal(view.calls.checkout, 0);
  view.unmount();
});

for (const [status, expected] of [
  ["none", /No original purchase was found in this browser/],
  ["paid", /Card payment confirmed. Treasury funding is pending/],
  ["paying", /Card payment confirmed. Treasury funding is pending/],
  ["failed", /Treasury funding failed. Contact the operator/],
  ["delivered", /credential has already been revealed/],
]) {
  test(`manual recovery handles ${status} without buying or revealing again`, async () => {
    const view = mount();
    await view.settle();
    view.status(async () => ({ status }));
    view.button().props.onClick();
    await view.settle();
    assert.match(view.html(), expected);
    assert.equal(view.calls.checkout, 0);
    assert.equal(view.calls.claim, 0);
    view.unmount();
  });
}

test("background polling preserves unpaid feedback, then clears it when funding progresses", async () => {
  const view = mount();
  await view.settle();
  view.button().props.onClick();
  await view.settle();
  view.poll();
  await view.settle();
  assert.match(view.html(), /still unpaid/);
  view.status(async () => ({ status: "paid" }));
  view.poll();
  await view.settle();
  assert.match(view.html(), /Card payment confirmed/);
  assert.doesNotMatch(view.html(), /still unpaid/);
  view.unmount();
});

test("manual checks reuse an in-flight background status request", async () => {
  const view = mount();
  await view.settle();
  let resolve;
  view.status(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  view.poll();
  view.button().props.onClick();
  view.render();
  assert.equal(view.calls.status.length, 2);
  resolve({ status: "ready" });
  await view.settle();
  assert.match(view.html(), /Funding verified/);
  assert.equal(view.button().props.disabled, false);
  view.unmount();
});
