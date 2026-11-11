import { randomBytes } from "node:crypto";

import { sha256Hex } from "@/server/runtime/crypto";

/**
 * Co-organizer invitation primitives (OP-120, contract §2.3, schema §13.6).
 *
 * An invitation is a **durable business fact** with a state machine, not a
 * delivery artefact, and one of its three decisions is that the invitee need
 * not have an account yet: an organizer may invite by user id, by email or by
 * phone. The module therefore owns the three pure decisions the route layer
 * must not re-invent:
 *
 * - {@link normalizeInvitee} — the canonical stored contact (lowercase email,
 *   E.164 phone, lowercase hex user id), which is exactly the form the
 *   post-sign-up lazy-invite hook (`@/server/auth/identity-hooks`) compares
 *   against, so an invite that precedes the account still matches on sign-up.
 * - {@link hashInvitationToken} / {@link generateInvitationToken} /
 *   {@link invitationByTokenFilter} — the raw token travels only inside the
 *   rendered email/SMS link, so the row stores `sha256(rawToken)` and the
 *   public preview looks the invitation up **by that hash** rather than using
 *   the raw token as a query value.
 * - {@link coOrganizerSeats} — the `coorganizers.per_event` usage, which counts
 *   active event members **and** live pending invitations: a pending invite
 *   already owns the seat, or an organizer could mail out unbounded invitations
 *   that all accept later.
 *
 * Everything here is pure: no database, no clock, no environment.
 */

/** The invitee kinds an invitation may be addressed to (schema §13.6). */
export type InviteeKind = "user" | "email" | "phone";

/** One invitation's invitee, as supplied by the caller. */
export interface InviteeInput {
  /** `user` | `email` | `phone`; any other value is refused as `unknown_kind`. */
  readonly kind: string;
  /** The Better Auth user id (24 hex characters), for `kind: "user"`. */
  readonly userId?: string | undefined;
  /** The email address, for `kind: "email"`. */
  readonly email?: string | undefined;
  /** The E.164 phone number, for `kind: "phone"`. */
  readonly phoneE164?: string | undefined;
}

/**
 * A canonical invitee: exactly the discriminating `kind` plus that kind's one
 * contact key.
 *
 * Carrying a second contact key would let the lazy-invite `$or` match two
 * accounts for one stored row, so the shape is narrowed rather than optional.
 */
export type NormalizedInvitee =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "phone"; readonly phoneE164: string };

/** Why an invitee was refused. */
export type InviteeProblem =
  "unknown_kind" | "missing_contact" | "invalid_user_id" | "invalid_email" | "invalid_phone";

/**
 * The outcome of {@link normalizeInvitee}.
 *
 * A **result**, not a throw, so the route can name the offending request path
 * in `details.fields[]` (the crate's `validation_failed` shape).
 */
export type NormalizeInviteeResult =
  | { readonly ok: true; readonly invitee: NormalizedInvitee }
  | { readonly ok: false; readonly code: InviteeProblem; readonly field: string };

/** A 24-hex-character Mongo id, the only shape a user id may take. */
const USER_ID_PATTERN = /^[0-9a-f]{24}$/;

/** A pragmatic address shape: a local part, an `@` and a dotted domain. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The separators an E.164 number may be written with and that are stripped. */
const PHONE_SEPARATORS = /[\s\-.()]/g;

/**
 * An E.164 number: `+`, a non-zero country digit, then up to 14 more digits.
 *
 * A number without the leading `+` is **refused rather than guessed** — the
 * country code is not inferable from the national significant number.
 */
const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

/** A refusal result. */
function refusal(code: InviteeProblem, field: string): NormalizeInviteeResult {
  return { ok: false, code, field };
}

/**
 * Normalize an invitee to the canonical stored contact (U1).
 *
 * The normalization is deliberately **total**: an absent contact is
 * `missing_contact`, a present-but-unusable one is `invalid_*`, and the
 * returned invitee carries exactly one contact key.
 *
 * @param input - The caller-supplied invitee.
 * @returns The canonical invitee, or the refusal naming the offending field.
 * @example normalizeInvitee({ kind: "email", email: "  Buck@Example.COM " });
 * // { ok: true, invitee: { kind: "email", email: "buck@example.com" } }
 */
export function normalizeInvitee(input: InviteeInput): NormalizeInviteeResult {
  switch (input.kind) {
    case "user": {
      if (input.userId === undefined) return refusal("missing_contact", "invitee.userId");
      const userId = input.userId.trim().toLowerCase();
      if (!USER_ID_PATTERN.test(userId)) return refusal("invalid_user_id", "invitee.userId");
      return { ok: true, invitee: { kind: "user", userId } };
    }
    case "email": {
      if (input.email === undefined) return refusal("missing_contact", "invitee.email");
      const email = input.email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(email)) return refusal("invalid_email", "invitee.email");
      return { ok: true, invitee: { kind: "email", email } };
    }
    case "phone": {
      if (input.phoneE164 === undefined) return refusal("missing_contact", "invitee.phoneE164");
      const phoneE164 = input.phoneE164.replace(PHONE_SEPARATORS, "");
      if (!PHONE_PATTERN.test(phoneE164)) return refusal("invalid_phone", "invitee.phoneE164");
      return { ok: true, invitee: { kind: "phone", phoneE164 } };
    }
    default:
      return refusal("unknown_kind", "invitee.kind");
  }
}

/**
 * Hash a raw invitation token with SHA-256, lowercase hex (U2).
 *
 * @param rawToken - The one-time token that travels in the link.
 * @returns 64 lowercase hex characters — the only form persisted.
 */
export function hashInvitationToken(rawToken: string): string {
  return sha256Hex(rawToken);
}

/**
 * Mint a raw invitation token (U2).
 *
 * 32 random bytes encoded as **unpadded** base64url: 43 URL-safe characters,
 * so the token can sit in a path segment unchanged and never needs escaping.
 *
 * @returns A fresh token.
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The public-preview lookup filter for a raw token (U2).
 *
 * The raw token is never a query value: the preview hashes it first, which is
 * also why a garbage token simply matches nothing.
 *
 * @param rawToken - The token read from the request path.
 * @returns The `{ tokenHash }` filter.
 */
export function invitationByTokenFilter(rawToken: string): { tokenHash: string } {
  return { tokenHash: hashInvitationToken(rawToken) };
}

/** An `event_organizers` row, as the seat count reads it (schema §15.2). */
export interface SeatMember {
  readonly role: "organizer" | "co_organizer";
  readonly status: "active" | "removed";
}

/** An `invitations` row, as the seat count reads it (schema §13.6). */
export interface SeatInvitation {
  readonly status: string;
  readonly expiresAt: Date;
}

/** The facts {@link coOrganizerSeats} counts. */
export interface CoOrganizerSeatInput {
  readonly members: readonly SeatMember[];
  readonly invitations: readonly SeatInvitation[];
  readonly now: Date;
}

/**
 * Count the `coorganizers.per_event` seats one event has consumed (U3).
 *
 * Every **active** event member counts — the organizer row included, because
 * §2.3 writes the usage as `eventMembers(active) + invitations(pending)` and the
 * organizer is an `event_organizers` row — plus every **live pending**
 * invitation. A `pending` invite whose `expiresAt` has already passed holds no
 * seat even before the hourly sweeper flips it, so a lapsing invite does not
 * block the replacement for up to an hour.
 *
 * @param input - The member rows, the invitation rows and the instant to judge
 *   the pending windows against.
 * @returns The number of seats consumed.
 */
export function coOrganizerSeats(input: CoOrganizerSeatInput): number {
  const nowMs = input.now.getTime();
  const members = input.members.filter((member) => member.status === "active").length;
  const pending = input.invitations.filter(
    (invitation) => invitation.status === "pending" && invitation.expiresAt.getTime() > nowMs
  ).length;
  return members + pending;
}
