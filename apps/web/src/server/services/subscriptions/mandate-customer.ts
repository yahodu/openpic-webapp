import { z } from "zod";

import type { MandateCustomer } from "@/server/payments/payment-provider";

/**
 * Derive the customer a mandate is created for (OP-107 checkout, OP-109
 * upgrade; ADR-0421 §4).
 *
 * The customer is **never** client-supplied: it comes from the acting account's
 * Better Auth user row (the email) and the profile's display name, with a
 * documented placeholder for a missing phone ({@link UNSET_CONTACT_PHONE}) and
 * for a missing address ({@link PLATFORM_NO_REPLY_EMAIL}) — a display name is
 * never handed to the vendor as an address. Both routes create a mandate for
 * the workspace owner, so both derive the customer identically.
 */

/**
 * The placeholder phone a mandate carries when the account has none on record.
 *
 * The vendor contract requires a non-empty `customer_phone`; an email-OTP
 * account may not have signed up a number yet, and the mandate is created by
 * the workspace owner, not by a customer filling in a form. Replace this with a
 * "verified phone required" refusal the moment the product collects one
 * (recorded as a coverage gap in ADR-0421).
 */
export const UNSET_CONTACT_PHONE = "0000000000";

/** The customer name used when the account has no display name. */
export const FALLBACK_CUSTOMER_NAME = "OpenPic customer";

/**
 * The address a mandate carries when the account has none on record.
 *
 * The vendor requires a non-empty `customer_email`, and the account row is the
 * only source of one. A display **name** is not an address, so the fallback is
 * the platform's own no-reply mailbox — the same shape of documented
 * placeholder as {@link UNSET_CONTACT_PHONE}.
 */
export const PLATFORM_NO_REPLY_EMAIL = "no-reply@openpic.in";

/** The acting account's contact fields (the Better Auth `user` document). */
const accountContactSchema = z.object({
  email: z.unknown().optional(),
  name: z.unknown().optional(),
  phoneNumber: z.unknown().optional(),
});

/** The profile's display-name field (the `userProfiles` document). */
const profileContactSchema = z.object({
  displayName: z.unknown().optional(),
});

/** A non-empty trimmed string, or `null`. */
function asContactText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Derive the customer a mandate is created for.
 *
 * @param user - The Better Auth `user` document, or `null`.
 * @param profile - The `userProfiles` document, or `null`.
 * @returns The port's {@link MandateCustomer}.
 */
export function resolveMandateCustomer(user: unknown, profile: unknown): MandateCustomer {
  const account = accountContactSchema.parse(user ?? {});
  const profileRow = profileContactSchema.parse(profile ?? {});
  return {
    name:
      asContactText(profileRow.displayName) ??
      asContactText(account.name) ??
      FALLBACK_CUSTOMER_NAME,
    email: asContactText(account.email) ?? PLATFORM_NO_REPLY_EMAIL,
    phone: asContactText(account.phoneNumber) ?? UNSET_CONTACT_PHONE,
  };
}
