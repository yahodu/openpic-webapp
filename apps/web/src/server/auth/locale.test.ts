import { describe, expect, it } from "vitest";

import { parseLocale } from "@/server/auth/locale";

/**
 * Unit contract — locale resolution from `Accept-Language` (OP-89, contract
 * §0.5 "Advisory headers", schema §13.2 `userProfiles.locale`).
 *
 * On first account creation the identity hook stores the caller's preferred
 * locale on `userProfiles.locale`. The only served locale today is `en-IN`, so
 * the resolver must pick a supported tag when the header names one and fall back
 * to the documented default otherwise — it must never store an unserved tag
 * that no template exists for.
 *
 * Contract expected of the implementation (`@/server/auth/locale`):
 *
 *   parseLocale(acceptLanguage: string | null | undefined, fallback?: string): string
 *
 *   - The fallback is `"en-IN"` when not supplied.
 *   - Parsing is case-insensitive and tolerant of surrounding whitespace.
 *   - A `q`-value list is honoured by choosing the supported candidate, not by
 *     trusting the first tag blindly (`fr;q=1.0,en-IN;q=0.8` still resolves to
 *     `en-IN`).
 *   - The bare language `en` resolves to the served regional tag `en-IN`.
 *   - An absent or wholly unsupported header resolves to the fallback.
 */

describe("parseLocale — Accept-Language resolution", () => {
  it("U1: returns the served locale for an exact en-IN tag", () => {
    expect(parseLocale("en-IN")).toBe("en-IN");
  });

  it("U1: maps the bare en language to the served en-IN tag", () => {
    expect(parseLocale("en")).toBe("en-IN");
  });

  it("U1: ignores unsupported languages and picks the supported candidate", () => {
    expect(parseLocale("fr-FR,de;q=0.9")).toBe("en-IN");
  });

  it("U1: honours the q-value list rather than the first tag", () => {
    expect(parseLocale("fr;q=1.0,de;q=0.9,en-IN;q=0.8")).toBe("en-IN");
  });

  it("U1: parses a full preference list down to the served tag", () => {
    expect(parseLocale("en-IN,en;q=0.9,fr;q=0.8")).toBe("en-IN");
  });

  it("U1: is case-insensitive", () => {
    expect(parseLocale("EN-in")).toBe("en-IN");
  });

  it("U1: tolerates surrounding whitespace", () => {
    expect(parseLocale("  en-IN , en;q=0.5 ")).toBe("en-IN");
  });

  it.each([null, undefined, ""])("U1: falls back to en-IN when the header is %s", (header) => {
    expect(parseLocale(header)).toBe("en-IN");
  });

  it("U1: falls back to en-IN when the header names no served locale", () => {
    expect(parseLocale("fr-FR")).toBe("en-IN");
  });

  it("U1: uses an explicitly supplied fallback instead of the default", () => {
    expect(parseLocale(null, "en-US")).toBe("en-US");
  });
});
