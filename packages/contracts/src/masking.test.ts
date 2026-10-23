import { describe, expect, it } from "vitest";

import { maskEmail, maskPhone, maskedContactSchema } from "@openpic/contracts";

/**
 * Unit — contact masking (OP-101, contract §0.13 "Masked contact" and §0.15
 * "Full email/phone of **another** user").
 *
 * §0.13 fixes the wire shape of a masked contact as `prefix + •` and gives two
 * examples: `"r•••@gmail.com"` and `"+91•••••3210"`. The *purpose* of the rule is
 * §0.15: a member listing must never carry another user's full address. That
 * purpose is what these pins encode, and it is why the mask is a **fixed-width
 * run** of bullets rather than one bullet per hidden character — a
 * length-proportional mask still tells the reader how long the hidden secret is,
 * and for a one-character local part it degenerates to no mask at all.
 *
 * ## Contract expected of the implementation
 *
 * `@openpic/contracts` must export two pure helpers:
 *
 *   - `maskEmail(address: string): string` — keeps the first character of the
 *     local part and the domain verbatim, and replaces the rest of the local
 *     part with exactly three `•`. Length-independent: every local part of a
 *     given length masks to the same string.
 *   - `maskPhone(e164: string): string` — keeps the leading `+`, the two-digit
 *     country code and the last four digits, and replaces the digits between
 *     them with exactly five `•`. Length-independent, like `maskEmail`.
 *
 * Both results must satisfy the existing `maskedContactSchema` (§0.13), which is
 * what the API response schema validates them against.
 *
 * ## Assumptions (recorded in ADR-0280)
 *
 * - **A1 — fixed mask widths.** The contract shows one example per helper and
 *   does not state whether the bullet run scales with the hidden input. Fixed
 *   widths (3 for email, 5 for phone) are pinned because they are the only
 *   reading under which the mask also hides the secret's *length*; the
 *   alternative is asserted against explicitly in the "never reveals" tests.
 * - **A2 — only the documented shapes are pinned.** The email cases use a
 *   single `@` with a plain or dotted domain; the phone cases use Indian E.164
 *   (`+91` + 10 digits), the shape §0.13 and the repo's default `dataRegion: "in"`
 *   both use. Other country codes and malformed inputs are deliberately not
 *   pinned: the contract says nothing about them.
 */

/** The mask character §0.13 specifies for a masked contact. */
const BULLET = "\u2022";

/** The three-bullet email mask §0.13 shows. */
const EMAIL_MASK = BULLET.repeat(3);

/** The five-bullet phone mask §0.13 shows. */
const PHONE_MASK = BULLET.repeat(5);

/**
 * The documented E.164 input, assembled from one source of truth.
 *
 * §0.13's example is `+91` followed by an Indian subscriber number; building the
 * input, the hidden run and the preserved tail from the same parts keeps the
 * assertions honest about which digits survive.
 */
const COUNTRY_CODE = "+91";
const SUBSCRIBER = "9876543210";
const HIDDEN = SUBSCRIBER.slice(1, -4);
const LAST_FOUR = SUBSCRIBER.slice(-4);
const NUMBER = `${COUNTRY_CODE}${SUBSCRIBER}`;

/** A second number on the same country code, with a different hidden run. */
const OTHER_SUBSCRIBER = "9812345678";
const OTHER_LAST_FOUR = OTHER_SUBSCRIBER.slice(-4);
const OTHER_NUMBER = `${COUNTRY_CODE}${OTHER_SUBSCRIBER}`;

describe("maskEmail", () => {
  it("U1: masks a Gmail address to `r•••@gmail.com`, keeping only the first local character", () => {
    expect(maskEmail("rahul@gmail.com")).toBe(`r${EMAIL_MASK}@gmail.com`);
  });

  it("U1: masks a single-character local part instead of leaving it readable", () => {
    expect(maskEmail("r@gmail.com")).toBe(`r${EMAIL_MASK}@gmail.com`);
  });

  it("U1: masks a two-character local part the same way as a long one", () => {
    expect(maskEmail("ra@gmail.com")).toBe(`r${EMAIL_MASK}@gmail.com`);
  });

  it("U1: never reveals how long the local part is", () => {
    // Every local part below starts with `r` and lives on the same domain, so a
    // length-proportional mask would produce a different string per line and
    // leak the length of the hidden address.
    const masks = [
      "r@gmail.com",
      "ra@gmail.com",
      "rahul@gmail.com",
      "rahul.menon@gmail.com",
      `${"r".repeat(40)}@gmail.com`,
    ].map((address) => maskEmail(address));

    expect(new Set(masks).size).toBe(1);
    expect(masks[0]).toBe(`r${EMAIL_MASK}@gmail.com`);
  });

  it("U1: preserves a multi-label domain verbatim", () => {
    expect(maskEmail("rahul@example.co.uk")).toBe(`r${EMAIL_MASK}@example.co.uk`);
  });

  it.each(["r@gmail.com", "ra@gmail.com", "rahul@gmail.com", "rahul.menon@example.co.uk"])(
    "U1: returns a §0.13 masked contact that never carries the original address (%s)",
    (address) => {
      const masked = maskEmail(address);

      expect(maskedContactSchema.safeParse(masked).success).toBe(true);
      expect(masked).not.toBe(address);
      expect(masked).not.toContain(address);

      // Everything after the first local character is the secret §0.15 forbids.
      const localSecret = address.slice(0, address.indexOf("@")).slice(1);
      if (localSecret !== "") {
        expect(masked).not.toContain(localSecret);
      }
    }
  );
});

describe("maskPhone", () => {
  it("U2: masks an Indian E.164 number to `+91•••••3210`", () => {
    expect(maskPhone(NUMBER)).toBe(`${COUNTRY_CODE}${PHONE_MASK}${LAST_FOUR}`);
  });

  it("U2: keeps the country code and the last four digits and hides every digit between them", () => {
    const masked = maskPhone(NUMBER);

    expect(masked.startsWith(COUNTRY_CODE)).toBe(true);
    expect(masked.endsWith(LAST_FOUR)).toBe(true);
    // The only surviving digits are the country code and the last four; the
    // five hidden digits are gone.
    expect(masked.replace(/\D/g, "")).toBe(`${COUNTRY_CODE.slice(1)}${LAST_FOUR}`);
    expect(masked).not.toContain(HIDDEN.slice(0, 5));
  });

  it("U2: never reveals how many digits are hidden", () => {
    const first = maskPhone(NUMBER);
    const second = maskPhone(OTHER_NUMBER);

    // Different numbers, same mask width: the hidden run must not scale with
    // the input, or the mask leaks the subscriber number's length.
    expect((first.match(/•/g) ?? []).length).toBe(5);
    expect((second.match(/•/g) ?? []).length).toBe(5);
    expect(second).toBe(`${COUNTRY_CODE}${PHONE_MASK}${OTHER_LAST_FOUR}`);
  });

  it.each([NUMBER, OTHER_NUMBER])(
    "U2: returns a §0.13 masked contact that never carries the original number (%s)",
    (number) => {
      const masked = maskPhone(number);

      expect(maskedContactSchema.safeParse(masked).success).toBe(true);
      expect(masked).not.toBe(number);
      expect(masked).not.toContain(number);
      expect(masked).not.toContain(number.slice(3, 8));
    }
  );
});
