import { describe, expect, it } from "vitest";

import { generateTenantSlug } from "@/server/tenancy/slug";

/**
 * Unit — the tenant slug generator (OP-100, contract §0.4, schema §13.3).
 *
 * `tenants.slug` is a *stable, public-ish handle* ("Stable handle for support
 * and admin URLs; **non-sequential**", schema §13.3) and it is unique
 * (`{slug:1}` unique, schema §13.3). Those two properties are the whole
 * contract: a slug must be URL-safe and fixed-width so it can be read aloud and
 * pasted, it must never collide, and it must not be guessable by walking a
 * counter (a sequential slug turns "show me tenant k7m2xq9p" into "show me
 * tenant 41").
 *
 * ## Contract expected of the implementation
 *
 * `@/server/tenancy/slug` must export `generateTenantSlug(): string` returning a
 * fresh, cryptographically-random slug on every call — 8 characters drawn from
 * `[a-z0-9]`. The generator owns only the *string*; uniqueness under
 * concurrency is enforced by the `{slug:1}` unique index plus the caller's
 * collision retry (see the provisioning spec).
 */

/** The documented slug shape: exactly eight lowercase-alphanumeric characters. */
const SLUG_PATTERN = /^[a-z0-9]{8}$/;

describe("generateTenantSlug", () => {
  it("U1: returns an 8-character lowercase alphanumeric slug", () => {
    expect(generateTenantSlug()).toMatch(SLUG_PATTERN);
  });

  it("U1: never returns an uppercase or URL-unsafe character", () => {
    // A single sample can pass by luck; the charset property must hold on every
    // draw, so sample enough that one bad character would be caught.
    for (let draw = 0; draw < 50; draw += 1) {
      expect(generateTenantSlug()).toMatch(SLUG_PATTERN);
    }
  });

  it("U1: returns a distinct slug on every call", () => {
    const draws = Array.from({ length: 200 }, () => generateTenantSlug());
    expect(new Set(draws).size).toBe(draws.length);
  });

  it("U1: does not hand out sequential, enumerable slugs", () => {
    // 20 draws that happen to be strictly ascending would mean the generator is
    // walking a counter (or a clock) rather than drawing randomly; the chance of
    // that for a random generator is 1/20!, i.e. never.
    const draws = Array.from({ length: 20 }, () => generateTenantSlug());
    const ascending = draws.every((slug, index) => index === 0 || (draws[index - 1] ?? "") < slug);
    expect(ascending).toBe(false);
  });
});
