/**
 * Log redaction — the security control that keeps sensitive keys and
 * secret-shaped values out of every transport (CONVENTIONS §5.3).
 *
 * Applied by the port *before* emission, so no transport can ever observe an
 * unredacted value:
 *   - by key, case-insensitively, deeply through nested objects and arrays;
 *   - by value pattern, anywhere in the free-text message or in any string
 *     field (Bearer tokens, `opat_` tokens, email addresses, E.164 numbers);
 *   - circular references are serialized as the string `[Circular]` so the
 *     entry always stays JSON-serializable.
 */

/** The marker substituted for a redacted key or masked value pattern. */
export const REDACTED_MARKER = "[REDACTED]";

/** The placeholder used for circular references. */
export const CIRCULAR_MARKER = "[Circular]";

/**
 * Key names (lower-cased) whose values are redacted wholesale, wherever they
 * appear in the entry graph.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "sessiontoken",
  "otp",
  "secret",
  "sig",
  "signature",
  "email",
  "phone",
  "phonenumber",
  "phonee164",
  "embedding",
  "vector",
  "vectors",
  "rawpayload",
  "queryvector",
]);

/**
 * Secret-shaped values masked inside free text. `Bearer` is listed first so a
 * token that also looks like an email/phone is consumed as a whole.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /opat_[A-Za-z0-9_-]{6,}/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\+[1-9][0-9*]{6,}/g,
];

/** Mask every secret-shaped pattern found in a free-text string. */
export function maskValuePatterns(value: string): string {
  let masked = value;
  for (const pattern of VALUE_PATTERNS) {
    masked = masked.replace(pattern, REDACTED_MARKER);
  }
  return masked;
}

/** True when a key is globally sensitive, or is `code` nested under `auth`. */
function isSensitiveKey(key: string, parentKey: string | undefined): boolean {
  const normalized = key.toLowerCase();
  if (SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  return normalized === "code" && parentKey?.toLowerCase() === "auth";
}

/** True for plain records (the shapes we recurse into), excluding arrays. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Recursively redact a value.
 *
 * @param key - The key this value is stored under, if any.
 * @param value - The value being traversed.
 * @param parentKey - The key of the containing object (for `auth.code`).
 * @param ancestors - Objects currently on the traversal path, for cycle detection.
 * @returns A redacted, JSON-safe value.
 */
function redactValue(
  key: string | undefined,
  value: unknown,
  parentKey: string | undefined,
  ancestors: Set<object>
): unknown {
  if (key !== undefined && isSensitiveKey(key, parentKey)) {
    return REDACTED_MARKER;
  }

  if (typeof value === "string") {
    return maskValuePatterns(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return CIRCULAR_MARKER;
    }
    ancestors.add(value);
    const nodes = value.map((item) => redactValue(undefined, item, undefined, ancestors));
    ancestors.delete(value);
    return nodes;
  }

  if (isPlainObject(value)) {
    if (ancestors.has(value)) {
      return CIRCULAR_MARKER;
    }
    ancestors.add(value);
    const redacted: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactValue(childKey, childValue, key, ancestors);
    }
    ancestors.delete(value);
    return redacted;
  }

  return value;
}

/**
 * Redact a fully-assembled entry.
 *
 * @param entry - The merged entry about to be emitted.
 * @param fields - The original call-site fields, seeded as an ancestor so a
 *   self-referential fields object is serialized as `[Circular]`.
 * @returns A redacted, JSON-serializable copy of the entry.
 */
export function redactEntry(
  entry: Record<string, unknown>,
  fields?: unknown
): Record<string, unknown> {
  const ancestors = new Set<object>();
  if (typeof fields === "object" && fields !== null) {
    ancestors.add(fields);
  }
  return redactValue(undefined, entry, undefined, ancestors) as Record<string, unknown>;
}
