import { z } from "zod";

/**
 * Shared wire primitives (API contract §0.15 / Appendix A).
 *
 * Each primitive pins exactly one wire format so a DTO cannot drift between the
 * frontend, the API and the React Native client. These are the atoms every
 * envelope and domain schema is assembled from; a looser primitive here is a
 * contract bug everywhere downstream.
 */

/** A MongoDB ObjectId rendered as 24 lowercase hexadecimal characters. */
export const idSchema = z.string().regex(/^[a-f0-9]{24}$/, {
  message: "Must be a 24-character lowercase hex id.",
});

/** Inferred DTO for {@link idSchema}. */
export type Id = z.infer<typeof idSchema>;

/**
 * An RFC 3339 UTC instant with millisecond precision and a trailing `Z`.
 *
 * A timestamp without a trailing `Z` names a different instant for every
 * reader, so a numeric offset, a missing millisecond field or a space instead
 * of the `T` separator is rejected rather than silently coerced.
 */
export const isoDateTimeSchema = z.iso.datetime({ offset: false, precision: 3 });

/** Inferred DTO for {@link isoDateTimeSchema}. */
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** A calendar date key in `YYYY-MM-DD` form, validating the real month and day. */
export const dateKeySchema = z.iso.date();

/** Inferred DTO for {@link dateKeySchema}. */
export type DateKey = z.infer<typeof dateKeySchema>;

/** A billing period key in `YYYY-MM` form. */
export const periodKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
  message: "Must be a billing period in YYYY-MM form.",
});

/** Inferred DTO for {@link periodKeySchema}. */
export type PeriodKey = z.infer<typeof periodKeySchema>;

/**
 * Whether `value` is an IANA time zone name or a canonical alias (`UTC`).
 *
 * `Intl.supportedValuesOf('timeZone')` omits canonical names such as `UTC` and
 * `Asia/Kolkata`, so validity is decided by whether `Intl.DateTimeFormat`
 * actually accepts the zone — the runtime is the source of truth for what it
 * can format, and a typo such as `Asia/Kolkatta` is rejected.
 *
 * @param value - The candidate time zone name.
 * @returns `true` when the runtime can format with the zone.
 */
function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A real IANA time zone name the runtime accepts. */
export const ianaTimeZoneSchema = z
  .string()
  .refine(isIanaTimeZone, { message: "Must be a known IANA time zone." });

/** Inferred DTO for {@link ianaTimeZoneSchema}. */
export type IanaTimeZone = z.infer<typeof ianaTimeZoneSchema>;

/**
 * A SHA-256 digest rendered as 64 lowercase hexadecimal characters.
 *
 * The case is part of the contract: an uppercase digest is the same secret
 * encoded differently, so two clients would compare equal values as unequal.
 */
export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, {
  message: "Must be a 64-character lowercase hex SHA-256 digest.",
});

/** Inferred DTO for {@link sha256HexSchema}. */
export type Sha256Hex = z.infer<typeof sha256HexSchema>;

/** An E.164 phone number: a `+`, a non-zero country code and up to 15 digits. */
export const e164Schema = z.string().regex(/^\+[1-9]\d{1,14}$/, {
  message: "Must be an E.164 number with a leading +.",
});

/** Inferred DTO for {@link e164Schema}. */
export type E164 = z.infer<typeof e164Schema>;

/** A non-negative integer amount in minor units (paise) plus its currency. */
export const moneySchema = z.object({
  amountMinor: z.int().min(0),
  currency: z.literal("INR"),
});

/** Inferred DTO for {@link moneySchema}. */
export type Money = z.infer<typeof moneySchema>;

/**
 * A partially masked contact channel (phone or email).
 *
 * The mask characters (`•` or `*`) are what make the value safe to return; an
 * unmasked number or address, whitespace or an empty string is not a masked
 * contact and is rejected.
 */
export const maskedContactSchema = z.string().regex(/^[^\s]*[•*][^\s]*$/, {
  message: "Must be a masked contact containing a mask character and no whitespace.",
});

/** Inferred DTO for {@link maskedContactSchema}. */
export type MaskedContact = z.infer<typeof maskedContactSchema>;
