// Copyright (c) 2026 Charles R. Strogish. All Rights Reserved.
// Dual-licensed under AGPLv3 and Commercial terms.

/** RFC 8785 over JSON data, without invoking toJSON or user-defined accessors.
 * Undefined object properties are omitted; undefined/holes in arrays and
 * non-JSON objects are rejected. Shared references are allowed, cycles are not.
 */
export function jcs(input: unknown): string {
  const ancestors = new Set<object>();
  function string(value: string): string {
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw new TypeError("JCS rejects unpaired UTF-16 surrogates.");
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new TypeError("JCS rejects unpaired UTF-16 surrogates.");
      }
    }
    return JSON.stringify(value);
  }
  function serialize(value: unknown): string {
    if (value === null) return "null";
    switch (typeof value) {
      case "string":
        return string(value);
      case "boolean":
        return JSON.stringify(value);
      case "number":
        if (!Number.isFinite(value))
          throw new TypeError("JCS requires finite numbers.");
        return JSON.stringify(value);
      case "object":
        break;
      default:
        throw new TypeError("JCS requires JSON data.");
    }
    const object = value as object;
    if (ancestors.has(object)) throw new TypeError("JCS rejects cyclic data.");
    if (Object.getOwnPropertySymbols(object).length)
      throw new TypeError("JCS rejects symbol properties.");
    if (
      !Array.isArray(object) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(object))
    )
      throw new TypeError("JCS requires plain JSON objects.");
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        if (
          Object.keys(object).some(
            (key) =>
              !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= object.length,
          )
        )
          throw new TypeError("JCS rejects non-index array properties.");
        const items: string[] = [];
        for (let i = 0; i < object.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(object, String(i));
          if (!descriptor || !("value" in descriptor))
            throw new TypeError("JCS rejects sparse arrays and accessors.");
          items.push(serialize(descriptor.value));
        }
        return `[${items.join(",")}]`;
      }
      const record = object as Record<string, unknown>;
      const keys = Object.keys(record).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const members: string[] = [];
      for (const key of keys) {
        const name = string(key);
        const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
        if (!("value" in descriptor))
          throw new TypeError("JCS rejects accessors.");
        if (descriptor.value !== undefined)
          members.push(`${name}:${serialize(descriptor.value)}`);
      }
      return `{${members.join(",")}}`;
    } finally {
      ancestors.delete(object);
    }
  }
  return serialize(input);
}
