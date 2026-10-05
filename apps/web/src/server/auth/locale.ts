/**
 * Locale resolution for the identity lifecycle hooks (OP-89, contract §0.5
 * "Advisory headers", schema §13.2 `userProfiles.locale`).
 *
 * The only locale the product serves today is `en-IN`. On first account
 * creation the user-created hook stores the caller's preferred locale on
 * `userProfiles.locale`, so this resolver must never persist a tag no template
 * exists for: an unsupported or absent `Accept-Language` falls back.
 */

/** The one served regional tag, and the default fallback. */
const SERVED_LOCALE = "en-IN";

/** A parsed `Accept-Language` candidate: a lowercased tag and its `q` weight. */
interface LocaleCandidate {
  readonly tag: string;
  readonly q: number;
}

/** Parse one comma-delimited entry into a tag + q-value, or `null` when empty. */
function parseCandidate(raw: string): LocaleCandidate | null {
  const segments = raw.split(";");
  const tag = (segments[0] ?? "").trim().toLowerCase();
  if (tag === "") {
    return null;
  }

  let q = 1;
  for (const segment of segments.slice(1)) {
    const [key, value] = segment.split("=");
    if (key?.trim().toLowerCase() === "q") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        q = parsed;
      }
    }
  }

  return { tag, q };
}

/** True when a parsed tag is one the product serves. */
function isServed(tag: string): boolean {
  // The bare language `en` resolves to the served regional tag, and the served
  // tag itself is matched case-insensitively.
  return tag === "en" || tag === "en-in";
}

/**
 * Resolve a served locale from an `Accept-Language` header.
 *
 * Parsing is case-insensitive, tolerant of surrounding whitespace, and honours
 * the `q`-value list: the highest-weighted *supported* candidate wins rather
 * than the first tag blindly.
 *
 * @param acceptLanguage - The raw `Accept-Language` header (may be absent).
 * @param fallback - The locale to return when no served candidate exists.
 *   Defaults to `"en-IN"`.
 * @returns A served locale tag, or `fallback`.
 * @example
 * parseLocale("fr;q=1.0,en-IN;q=0.8"); // "en-IN"
 */
export function parseLocale(
  acceptLanguage: string | null | undefined,
  fallback: string = SERVED_LOCALE
): string {
  if (typeof acceptLanguage !== "string") {
    return fallback;
  }

  const candidates: LocaleCandidate[] = [];
  for (const raw of acceptLanguage.split(",")) {
    const candidate = parseCandidate(raw);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }

  candidates.sort((left, right) => right.q - left.q);

  for (const candidate of candidates) {
    if (isServed(candidate.tag)) {
      return SERVED_LOCALE;
    }
  }

  return fallback;
}
