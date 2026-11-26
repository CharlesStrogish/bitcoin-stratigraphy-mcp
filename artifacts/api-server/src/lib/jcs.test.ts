// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.
import assert from "node:assert/strict";
import test from "node:test";
import { jcs } from "./jcs";

test("JCS uses UTF-16 code units, including RFC 8785 property-sorting vector", () => {
  const value = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\ud83d\ude00": "Emoji: Grinning Face",
    "\u0080": "Control",
    "\u00f6": "Latin",
  };
  assert.equal(
    jcs(value),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
  assert.equal(jcs({ "\ufffd": 3, "😀": 2, a: 1 }), '{"a":1,"😀":2,"�":3}');
  assert.equal(jcs({ "2": "two", "10": "ten" }), '{"10":"ten","2":"two"}');
});

test("JCS uses ECMAScript number serialization and normalizes negative zero", () => {
  assert.equal(
    jcs([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0]),
    "[333333333.3333333,1e+30,4.5,0.002,1e-27,0]",
  );
  assert.equal(
    jcs([Number.MIN_VALUE, Number.MAX_VALUE, 1e-6, 1e-7, 1e20, 1e21]),
    "[5e-324,1.7976931348623157e+308,0.000001,1e-7,100000000000000000000,1e+21]",
  );
});

test("JCS recursively serializes JSON and omits only undefined object members", () => {
  assert.equal(
    jcs({
      z: [null, true, false, { z: undefined, b: 2, a: 1 }],
      gone: undefined,
      a: '\b\t\n\f\r"\\\u0000',
    }),
    '{"a":"\\b\\t\\n\\f\\r\\"\\\\\\u0000","z":[null,true,false,{"a":1,"b":2}]}',
  );
  assert.equal(
    jcs(Object.assign(Object.create(null), { b: 2, a: 1 })),
    '{"a":1,"b":2}',
  );
  const shared = { x: 1 };
  assert.equal(jcs([shared, shared]), '[{"x":1},{"x":1}]');
  assert.notEqual(jcs("é"), jcs("e\u0301"), "JCS must not normalize Unicode");
});

test("JCS rejects every non-finite number, including nested members", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => jcs(value), /finite/);
    assert.throws(() => jcs({ nested: [value] }), /finite/);
  }
});

test("JCS rejects lone surrogates in names and values but permits valid pairs", () => {
  for (const value of ["\ud800", "\udfff", "x\udbff!", "\udc00\ud800"]) {
    assert.throws(() => jcs(value), /surrogates/);
    assert.throws(() => jcs({ [value]: "value" }), /surrogates/);
    assert.throws(() => jcs({ value }), /surrogates/);
  }
  assert.equal(jcs(["\ud800\udc00", "\udbff\udfff"]), '["𐀀","􏿿"]');
});

test("JCS rejects BigInt, functions, symbols, undefined roots and undefined array items", () => {
  for (const value of [1n, () => 1, Symbol("synthetic"), undefined]) {
    assert.throws(() => jcs(value), TypeError);
    assert.throws(() => jcs([value]), TypeError);
    if (value !== undefined) assert.throws(() => jcs({ value }), TypeError);
  }
  assert.throws(() => jcs({ [Symbol("synthetic")]: 1 }), /symbol/);
  assert.throws(() => jcs(Array(1)), /sparse/);
});

test("JCS rejects cycles, non-JSON objects and accessors without executing them", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => jcs(cycle), /cyclic/);
  for (const value of [new Date(), new Map(), new Number(1), new Set()])
    assert.throws(() => jcs(value), /plain/);
  let invoked = false;
  assert.throws(
    () =>
      jcs({
        get value() {
          invoked = true;
          return 1;
        },
      }),
    /accessors/,
  );
  assert.throws(
    () =>
      jcs({
        toJSON() {
          invoked = true;
          return {};
        },
      }),
    TypeError,
  );
  const array = [1];
  Object.defineProperty(array, "0", {
    get() {
      invoked = true;
      return 1;
    },
  });
  assert.throws(() => jcs(array), /accessors/);
  assert.equal(invoked, false);
});
