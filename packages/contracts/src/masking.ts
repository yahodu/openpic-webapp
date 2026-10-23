/**
 * Masked-contact helpers (API contract §0.13 "Masked contact", §0.15).
 *
 * §0.13 fixes the *wire shape* of a masked contact — a readable prefix followed
 * by mask characters (`•`/`*`) — and §0.15 forbids ever returning another
 * user's full email or phone. A mask that scales with the hidden value still
 * discloses *how long* the secret is (and a one-character local part would come
 * back unmasked), so both helpers use a **fixed-width** bullet run: the caller
 * cannot infer the hidden length from the response.
 *
 * The helpers are pure and total: they never throw on the shapes §0.13
 * documents, and a malformed input degrades to a fully-masked value rather than
 * leaking the input verbatim.
 */

/** The mask character §0.13 specifies for a masked contact. */
const BULLET = "\u2022";

/** The fixed three-bullet run §0.13 shows for a masked email. */
const EMAIL_MASK = BULLET.repeat(3);

/** The fixed five-bullet run §0.13 shows for a masked phone number. */
const PHONE_MASK = BULLET.repeat(5);

/**
 * Mask an email address to the §0.13 wire shape.
 *
 * Keeps the first character of the local part and the domain verbatim, and
 * replaces everything between them with exactly three `•`. The width is fixed,
 * so two addresses on the same domain with the same first character mask to the
 * same string and the hidden local part's length never leaks (§0.15).
 *
 * @param address - The raw email address.
 * @returns The masked contact, safe to return to another user.
 * @example
 * maskEmail("rahul@gmail.com"); // "r•••@gmail.com"
 */
export function maskEmail(address: string): string {
  const at = address.indexOf("@");
  const first = address[0];
  if (at <= 0 || first === undefined) {
    // No usable local/domain split: mask the whole value rather than echo it.
    return EMAIL_MASK;
  }
  return `${first}${EMAIL_MASK}${address.slice(at)}`;
}

/**
 * Mask an E.164 phone number to the §0.13 wire shape.
 *
 * Keeps the leading `+`, the two-digit country code and the last four digits,
 * and replaces every digit between them with exactly five `•`. The width is
 * fixed, so the number of hidden digits never leaks (§0.15).
 *
 * @param e164 - The raw E.164 phone number.
 * @returns The masked contact, safe to return to another user.
 * @example
 * maskPhone("+919876543210"); // "+91•••••3210"
 */
export function maskPhone(e164: string): string {
  const plus = e164.startsWith("+") ? "+" : "";
  const digits = e164.replace(/\D/g, "");
  const countryCode = digits.slice(0, 2);
  const lastFour = digits.slice(-4);
  return `${plus}${countryCode}${PHONE_MASK}${lastFour}`;
}
