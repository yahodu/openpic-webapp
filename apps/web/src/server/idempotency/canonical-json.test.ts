import { describe, expect, it } from "vitest";

import { canonicalJson } from "./index";

/**
 * U1 — `canonicalJson` (API contract §0.9).
 *
 * The idempotency `requestHash` is only stable if two bodies that are
 * semantically equal but written with a different key order produce the same
 * bytes. `canonicalJson` is that deterministic serializer: object keys are
 * sorted recursively, arrays keep their element order, and the output is
 * compact JSON that round-trips through `JSON.parse`.
 *
 * Expected output is asserted literally (not via a second implementation) so a
 * regression in key sorting or array handling fails loudly.
 */

describe("canonicalJson", () => {
  it("U1: is independent of object key order at every depth", () => {
    const first = { z: 1, a: { d: 4, c: 3 }, m: [{ y: 2, x: 1 }] };
    const second = { a: { c: 3, d: 4 }, m: [{ x: 1, y: 2 }], z: 1 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("U1: sorts nested object keys and preserves array element order", () => {
    expect(canonicalJson({ b: 1, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":1}');
  });

  it("U1: canonicalizes objects nested inside arrays", () => {
    expect(
      canonicalJson([
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ])
    ).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
  });

  it("U1: emits compact JSON for scalars", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
  });

  it("U1: omits undefined object members but keeps array positions", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("U1: output is valid JSON that parses back to the input value", () => {
    const value = { b: [1, { d: 4, c: [true, null] }], a: "s" };

    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});
