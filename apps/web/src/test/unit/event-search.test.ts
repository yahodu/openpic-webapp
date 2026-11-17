import { describe, expect, it } from "vitest";

import { buildNamePrefixRegex, escapeRegex } from "@/server/events/search";

/**
 * Unit — the events list `q` search (OP-116 U1, contract §4.1).
 *
 * The list endpoint's `?q=` is a **case-insensitive prefix on the event name**
 * built from a caller-supplied string. Because the caller controls the string,
 * every regex metacharacter must be escaped before the prefix is wrapped and
 * anchored — otherwise `[a-z]`, `.*` or `^` injected into `q` would rewrite
 * the query (a regex-injection / ReDoS surface). `buildNamePrefixRegex` must
 * therefore build `/^<escaped-q>/i` so the metacharacters act as literals and
 * the query can never widen the match set beyond the literal prefix.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/events/search
 *   escapeRegex(value: string): string
 *     // every regex metacharacter is prefixed with a backslash; others unchanged
 *   buildNamePrefixRegex(query: string): RegExp
 *     // new RegExp(`^${escapeRegex(query)}`, "i")  — anchored + case-insensitive
 * ```
 */

/** The regex metacharacters that must be escaped when matched literally. */
const METACHARACTERS = [".", "^", "$", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "\\"];

describe("escapeRegex (U1)", () => {
  it.each(METACHARACTERS)("escapes the regex metacharacter %j as a literal", (char) => {
    expect(escapeRegex(char)).toBe(`\\${char}`);
  });

  it("escapes every metacharacter in a mixed string", () => {
    expect(escapeRegex("a.b*c?d[e]f|g")).toBe("a\\.b\\*c\\?d\\[e\\]f\\|g");
  });

  it.each(["a", "Z", "0", "_", "-", " ", "é", "😀"])(
    "leaves the ordinary character %j untouched",
    (char) => {
      expect(escapeRegex(char)).toBe(char);
    }
  );

  it("escapes a lone backslash to two backslashes", () => {
    expect(escapeRegex("\\")).toBe("\\\\");
  });
});

describe("buildNamePrefixRegex (U1)", () => {
  it("matches a case-insensitive literal prefix", () => {
    const regex = buildNamePrefixRegex("Wed");
    expect(regex.source.startsWith("^")).toBe(true);
    expect(regex.flags.includes("i")).toBe(true);
    expect("Wedding 2026").toMatch(regex);
    expect("wedding 2026").toMatch(regex);
  });

  it("anchors the prefix at the start of the name", () => {
    const regex = buildNamePrefixRegex("wedd");
    expect("My Wedding").not.toMatch(regex);
  });

  it("treats a character-class injection as literal text, not a class", () => {
    const regex = buildNamePrefixRegex("R[a-z]d");
    expect("Rad").not.toMatch(regex);
    expect("Rzd").not.toMatch(regex);
    expect("R[a-z]d").toMatch(regex);
  });

  it("treats a dot as a literal dot, not a wildcard", () => {
    const regex = buildNamePrefixRegex("a.c");
    expect("abc").not.toMatch(regex);
    expect("a.c").toMatch(regex);
  });

  it("defeats a `.*` injection instead of matching everything", () => {
    const regex = buildNamePrefixRegex(".*");
    expect("any arbitrary string").not.toMatch(regex);
    expect(".*").toMatch(regex);
  });

  it("treats a leading caret as a literal, not a second anchor", () => {
    const regex = buildNamePrefixRegex("^wed");
    expect("wedding").not.toMatch(regex);
    expect("^wedding").toMatch(regex);
  });
});
