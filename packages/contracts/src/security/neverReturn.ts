/**
 * Never-return scanner (CONVENTIONS §8.1, API contract §0.15).
 *
 * A response projection must never carry credential material, upstream payloads
 * or internal identifiers. Every endpoint story runs this scanner over its
 * response body, so it must descend through arrays of objects (a collection
 * page is where leaks actually happen) and know the audience: an attendee must
 * not receive a face-match `similarity`, while an admin legitimately receives a
 * `rawPayload`.
 */

/** The audience a response is being projected for. */
export type NeverReturnProfile = "default" | "attendee" | "admin" | "issuance";

/** Keys that are forbidden for every profile, wherever they appear. */
const ALWAYS_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "embedding",
  "vectors",
  "queryVector",
  "tokenHash",
  "objectKey",
  "locationKey",
  "bucket",
  "externalRefs",
  "providerCode",
  "_id",
]);

/**
 * An R2 endpoint hostname (`<account>.r2.cloudflarestorage.com`), which must
 * never be returned even when embedded inside a longer string such as a note.
 */
const R2_ENDPOINT_HOST = /(?:^|[^a-z0-9-])[a-z0-9-]+\.r2\.cloudflarestorage\.com/i;

/**
 * Whether `key` is forbidden for `profile`.
 *
 * `sessionToken` is legitimate only for the token-issuing endpoint, and
 * `rawPayload` only for an admin — every other audience must not receive them.
 * `similarity` is a face-match score that only an attendee view must suppress.
 *
 * @param key - The candidate object key.
 * @param profile - The audience the response is projected for.
 * @returns `true` when the key must not be serialised.
 */
function isForbiddenKey(key: string, profile: NeverReturnProfile): boolean {
  if (ALWAYS_FORBIDDEN_KEYS.has(key)) {
    return true;
  }
  if (key === "sessionToken") {
    return profile !== "issuance";
  }
  if (key === "rawPayload") {
    return profile !== "admin";
  }
  if (key === "similarity") {
    return profile === "attendee";
  }
  return false;
}

/** Whether `value` is a non-null, non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively collect the dot-paths of forbidden fields in `value`.
 *
 * Traversal is a depth-first walk in object-key (and array-index) order, so the
 * returned paths are deterministic and match the `FieldError.path` convention
 * (`items.0.hash`).
 *
 * @param value - The node being scanned.
 * @param path - The dot-path that reaches `value`.
 * @param profile - The audience the response is projected for.
 * @param found - The accumulator of offending paths.
 */
function scan(value: unknown, path: string, profile: NeverReturnProfile, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      scan(element, path === "" ? String(index) : `${path}.${String(index)}`, profile, found);
    });
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const forbiddenKey = isForbiddenKey(key, profile);
    if (forbiddenKey) {
      found.push(childPath);
    }

    if (typeof child === "string") {
      if (!forbiddenKey && R2_ENDPOINT_HOST.test(child)) {
        found.push(childPath);
      }
      continue;
    }

    scan(child, childPath, profile, found);
  }
}

/**
 * Find every forbidden field in a response body.
 *
 * @param body - The response body to scan (untested upstream data).
 * @param profile - The audience the response is projected for.
 * @returns The dot-paths of the offending fields, in depth-first order; empty
 *   means the body is safe to return.
 * @example
 * findForbiddenFields({ items: [{ id: "a" }, { embedding: [] }] }, "default");
 * // ["items.1.embedding"]
 */
export function findForbiddenFields(
  body: unknown,
  profile: NeverReturnProfile = "default"
): string[] {
  const found: string[] = [];
  scan(body, "", profile, found);
  return found;
}
