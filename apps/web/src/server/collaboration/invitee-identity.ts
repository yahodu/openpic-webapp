/**
 * Invitee identity matching for an invitation decision (OP-121, contract §2.3,
 * schema §13.6).
 *
 * An invitation names its invitee one of three ways — a `user` id, an `email`
 * or an E.164 `phoneE164` — and the decision endpoints must answer *is the
 * caller the invitee?* before they resolve anything. The three normalization
 * rules live here, once, so both the `/me` and the token path ask the same
 * question. Pure: no database, no clock.
 */

/** The stored `invitations.invitee` (schema §13.6). */
export interface InviteeContact {
  /** `user` | `email` | `phone`. */
  readonly kind?: unknown;
  /** Also set by the post-sign-up lazy-invite hook (OP-89). */
  readonly userId?: unknown;
  readonly email?: unknown;
  readonly phoneE164?: unknown;
}

/** The signed-in caller. */
export interface InviteeAccount {
  readonly userId: string;
  readonly email?: string | null;
  readonly phoneE164?: string | null;
  readonly emailVerified?: boolean;
  readonly phoneNumberVerified?: boolean;
}

/** Whether the caller is the invitee, and whether the contact is proven. */
export type InviteeMatch =
  { readonly matched: false } | { readonly matched: true; readonly contactVerified: boolean };

/** The separators a person types into a phone number, ignored when comparing. */
const PHONE_SEPARATORS = /[\s\-.()]/g;

/** The result for a caller the invitation does not name. */
const NO_MATCH: InviteeMatch = { matched: false };

/**
 * Compare two identifiers case-insensitively, trimming only an email/phone.
 *
 * @param stored - The value on the invitation row.
 * @param presented - The value on the caller's account.
 * @returns `true` when both are present and equal.
 */
function sameContact(stored: unknown, presented: unknown): boolean {
  if (typeof stored !== "string" || typeof presented !== "string") {
    return false;
  }
  return stored.trim().toLowerCase() === presented.trim().toLowerCase();
}

/**
 * Compare a phone number on its E.164 digits.
 *
 * Only the separators a person types are stripped (U2-A4): a number without a
 * leading `+` is never guessed into E.164, and no digit is dropped.
 *
 * @param stored - The number on the invitation row.
 * @param presented - The number on the caller's account.
 * @returns `true` when both normalize to the same string.
 */
function samePhone(stored: unknown, presented: unknown): boolean {
  if (typeof stored !== "string" || typeof presented !== "string") {
    return false;
  }
  return stored.replace(PHONE_SEPARATORS, "") === presented.replace(PHONE_SEPARATORS, "");
}

/**
 * True when the row's lazy-linked account id names the caller (U2-A2).
 *
 * @param stored - The row's `invitee.userId`.
 * @param account - The caller.
 * @returns `true` when the ids match whatever their case.
 */
function linkedTo(stored: unknown, account: InviteeAccount): boolean {
  return sameContact(stored, account.userId);
}

/**
 * Match the stored invitee against the signed-in caller.
 *
 * @param invitee - The invitation's stored `invitee` subdocument.
 * @param account - The caller's account.
 * @returns `{ matched: false }` when the caller is not the invitee; otherwise
 *   `{ matched: true, contactVerified }`, where an email/phone invitation is
 *   only as verified as the matching contact on the account (U2-A3).
 */
export function matchInvitee(invitee: InviteeContact, account: InviteeAccount): InviteeMatch {
  switch (invitee.kind) {
    case "user":
      // A user-kind invitation names the account itself, so there is no contact
      // to prove (U2-A1).
      return sameContact(invitee.userId, account.userId)
        ? { matched: true, contactVerified: true }
        : NO_MATCH;
    case "email":
      if (invitee.email === undefined && invitee.userId === undefined) return NO_MATCH;
      if (!linkedTo(invitee.userId, account) && !sameContact(invitee.email, account.email)) {
        return NO_MATCH;
      }
      return { matched: true, contactVerified: account.emailVerified === true };
    case "phone":
      if (invitee.phoneE164 === undefined && invitee.userId === undefined) return NO_MATCH;
      if (!linkedTo(invitee.userId, account) && !samePhone(invitee.phoneE164, account.phoneE164)) {
        return NO_MATCH;
      }
      return { matched: true, contactVerified: account.phoneNumberVerified === true };
    default:
      return NO_MATCH;
  }
}
