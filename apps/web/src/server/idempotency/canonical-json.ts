/**
 * Canonical JSON (API contract §0.9).
 *
 * The idempotency `requestHash` is only stable if two bodies that are
 * semantically equal but written with a different key order produce the same
 * bytes. `canonicalJson` is that deterministic serializer: object keys are
 * sorted recursively, arrays keep their element order, and `undefined` object
 * members are dropped (arrays keep their position as `null`).
 */

/** Recursively rebuild `value` with object keys sorted and undefined members dropped. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => canonicalize(element));
  }

  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) {
        continue;
      }
      sorted[key] = canonicalize(child);
    }
    return sorted;
  }

  return value;
}

/**
 * Serialize `value` as compact JSON with recursively sorted object keys.
 *
 * @param value - Any JSON-representable value.
 * @returns The canonical, compact JSON string.
 * @example
 * canonicalJson({ b: 1, a: [3, 1, 2] }); // '{"a":[3,1,2],"b":1}'
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
