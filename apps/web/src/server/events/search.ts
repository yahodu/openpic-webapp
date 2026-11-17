/**
 * Event name search helpers (OP-116, contract §4.1).
 *
 * The events list endpoint's `?q=` is a **case-insensitive prefix on the event
 * name** built from a caller-supplied string. Because the caller controls the
 * string, every regex metacharacter must be escaped before the prefix is
 * wrapped and anchored — otherwise `[a-z]`, `.*` or `^` injected into `q`
 * would rewrite the query (a regex-injection / ReDoS surface). The pieces here
 * keep that guarantee in one tested module: `buildNamePrefixRegex` always
 * builds `/^<escaped-q>/i` so metacharacters act as literals and the query can
 * never widen the match set beyond the literal prefix.
 */

/** The regex metacharacters that must be escaped when matched literally. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape every regex metacharacter in a caller-supplied string.
 *
 * Ordinary characters (letters, digits, spaces, unicode) pass through
 * untouched; each metacharacter (`\ ^ $ . * + ? ( ) [ ] { } |`) is prefixed
 * with a backslash so it is matched literally when the string is composed into
 * a `RegExp`.
 *
 * @param value - The caller-supplied query fragment.
 * @returns The same text with every metacharacter escaped.
 */
export function escapeRegex(value: string): string {
  return value.replace(REGEX_METACHARACTERS, "\\$&");
}

/**
 * Build the anchored, case-insensitive name-prefix regex for `?q=`.
 *
 * The regex matches every event name that **starts with** the literal (fully
 * escaped) query text, ignoring case — and nothing else: an injected
 * character class, wildcard or anchor cannot widen the match set because it
 * was escaped away by {@link escapeRegex} before composition.
 *
 * @param query - The raw `?q=` value.
 * @returns `/^<escaped-query>/i`.
 */
export function buildNamePrefixRegex(query: string): RegExp {
  return new RegExp(`^${escapeRegex(query)}`, "i");
}
