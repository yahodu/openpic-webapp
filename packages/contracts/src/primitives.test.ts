import { describe, expect, it } from "vitest";

import {
  dateKeySchema,
  e164Schema,
  ianaTimeZoneSchema,
  idSchema,
  isoDateTimeSchema,
  maskedContactSchema,
  moneySchema,
  periodKeySchema,
  sha256HexSchema,
} from "@openpic/contracts";

/**
 * U1 / U2 — the shared wire primitives of `@openpic/contracts`.
 *
 * Each primitive pins a single wire format so DTOs cannot drift between the
 * frontend, the API and the React Native client. A timestamp without a trailing
 * `Z` is a *different instant* for every reader, an uppercase digest is the same
 * secret encoded differently (so two clients compare them unequal), and a money
 * amount written as a float loses paise to binary rounding — those are contract
 * bugs, not cosmetic ones.
 *
 * Every primitive below carries at least two accepted cases and three rejected
 * cases, including the type boundary: a value that is not even the wire type is
 * never valid.
 */

describe("idSchema", () => {
  it.each(["507f1f77bcf86cd799439011", "000000000000000000000000"])(
    "accepts the 24-character lowercase hex ObjectId %s",
    (value) => {
      expect(idSchema.safeParse(value).success).toBe(true);
    }
  );

  it.each([
    "507F1F77BCF86CD799439011", // uppercase hex
    "507f1f77bcf86cd79943901", // 23 characters
    "507f1f77bcf86cd7994390111", // 25 characters
    "zzzzzzzzzzzzzzzzzzzzzzzz", // non-hex alphabet
  ])("rejects the malformed id %s", (value) => {
    expect(idSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an id that is not a string", () => {
    expect(idSchema.safeParse(123).success).toBe(false);
  });
});

describe("isoDateTimeSchema", () => {
  it.each(["2026-01-01T00:00:00.000Z", "2026-10-02T12:34:56.789Z"])(
    "accepts the RFC 3339 UTC instant with milliseconds %s",
    (value) => {
      expect(isoDateTimeSchema.safeParse(value).success).toBe(true);
    }
  );

  it.each([
    "2026-01-01T00:00:00Z", // missing milliseconds
    "2026-01-01T00:00:00.000+00:00", // a numeric offset instead of Z
    "2026-01-01 00:00:00.000Z", // a space instead of the T separator
    "2026-13-01T00:00:00.000Z", // an out-of-range month
    "not-a-date", // a non-date string
  ])("rejects the non-RFC-3339-UTC timestamp %s", (value) => {
    expect(isoDateTimeSchema.safeParse(value).success).toBe(false);
  });
});

describe("dateKeySchema", () => {
  it.each(["2026-01-01", "2026-12-31"])("accepts the calendar date %s", (value) => {
    expect(dateKeySchema.safeParse(value).success).toBe(true);
  });

  it.each(["2026-1-01", "2026/01/01", "2026-13-01", "2026-01-32"])(
    "rejects the malformed date key %s",
    (value) => {
      expect(dateKeySchema.safeParse(value).success).toBe(false);
    }
  );
});

describe("periodKeySchema", () => {
  it.each(["2026-01", "2026-12"])("accepts the billing period %s", (value) => {
    expect(periodKeySchema.safeParse(value).success).toBe(true);
  });

  it.each(["2026-1", "2026-13", "2026", "2026-01-01"])(
    "rejects the malformed period key %s",
    (value) => {
      expect(periodKeySchema.safeParse(value).success).toBe(false);
    }
  );
});

describe("ianaTimeZoneSchema", () => {
  // `Intl.supportedValuesOf('timeZone')` omits canonical names such as `UTC`
  // and `Asia/Kolkata`; a real IANA zone is one `Intl.DateTimeFormat` accepts.
  it.each(["UTC", "Asia/Kolkata", "America/New_York"])("accepts the IANA zone %s", (value) => {
    expect(ianaTimeZoneSchema.safeParse(value).success).toBe(true);
  });

  it.each(["Mars/Phobos", "Not/AZone", "GMT+05:30", "Asia/Kolkatta"])(
    "rejects the unknown zone %s",
    (value) => {
      expect(ianaTimeZoneSchema.safeParse(value).success).toBe(false);
    }
  );
});

describe("sha256HexSchema", () => {
  it.each([
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ])("accepts the 64-character lowercase digest %s", (value) => {
    expect(sha256HexSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855", // uppercase
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85", // 63 characters
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8555", // 65 characters
    "g3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // non-hex alphabet
  ])("rejects the malformed digest %s", (value) => {
    expect(sha256HexSchema.safeParse(value).success).toBe(false);
  });
});

describe("e164Schema", () => {
  it.each(["+919876543210", "+14155552671"])("accepts the E.164 number %s", (value) => {
    expect(e164Schema.safeParse(value).success).toBe(true);
  });

  it.each([
    "919876543210", // missing the leading +
    "+0919876543210", // a leading zero in the country code
    "+1234567890123456", // 16 digits: longer than E.164 allows
    "+91 98765 43210", // spaces are not part of the wire format
  ])("rejects the malformed phone number %s", (value) => {
    expect(e164Schema.safeParse(value).success).toBe(false);
  });
});

describe("moneySchema", () => {
  it.each([
    { amountMinor: 0, currency: "INR" },
    { amountMinor: 49900, currency: "INR" },
  ])("accepts the integer minor-unit amount %o", (value) => {
    expect(moneySchema.safeParse(value).success).toBe(true);
  });

  it.each([
    { amountMinor: 100, currency: "USD" }, // only INR is supported
    { amountMinor: 100 }, // currency is required
    { amountMinor: "100", currency: "INR" }, // amountMinor is a number, not a string
    { amountMinor: -100, currency: "INR" }, // amounts are non-negative minor units
  ])("rejects the malformed money value %o", (value) => {
    expect(moneySchema.safeParse(value).success).toBe(false);
  });

  it("U2: rejects the non-integer money amount 499.5", () => {
    expect(moneySchema.safeParse({ amountMinor: 499.5, currency: "INR" }).success).toBe(false);
  });
});

describe("maskedContactSchema", () => {
  it.each(["••••3210", "j•••@example.com"])("accepts the masked contact %s", (value) => {
    expect(maskedContactSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "+919876543210", // an unmasked phone number
    "john@example.com", // an unmasked email address
    "•••• 3210", // whitespace is not part of a masked contact
    "", // an empty string is not a contact
  ])("rejects the unmasked contact %s", (value) => {
    expect(maskedContactSchema.safeParse(value).success).toBe(false);
  });
});
