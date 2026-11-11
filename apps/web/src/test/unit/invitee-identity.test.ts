import { describe, expect, it } from "vitest";

import { matchInvitee } from "@/server/collaboration/invitee-identity";

/**
 * Unit — invitee identity matching for an invitation decision (OP-121 U2,
 * contract §2.3, schema §13.6).
 *
 * An invitation stores only a canonical **invitee** (§13.6): a `user` id, an
 * `email` or an E.164 `phoneE164`. The decision endpoints must answer one
 * authorization question before they resolve anything: *is the caller the
 * invitee?* (§2.3: the token path answers `401` unauthenticated, `403
 * invitation_not_for_you` for a different user, and resolves when the invitee
 * "matches/resolves").
 *
 * Three normalization rules make that question answerable, and none of them
 * needs a database:
 *
 * - a **user** id matches case-insensitively (Better Auth ids are 24 lowercase
 *   hex characters, but a caller may present them in either case);
 * - an **email** matches case-insensitively and ignores surrounding
 *   whitespace, because §2.3's create path stores the lowercase form and a
 *   sign-up may arrive with any casing;
 * - a **phone** matches on its E.164 digits, ignoring the separators a human
 *   types (`+91 98765-43210`), and never guesses a country code.
 *
 * The match also reports whether the matched **contact is verified**: an
 * invitation addressed to an email or a phone is proof of *contact ownership*,
 * so an account whose matching contact is unverified must not be able to take
 * the invitation (OP-121 I9, `403`). A `user`-kind invitation names the account
 * itself and needs no contact proof.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/collaboration/invitee-identity
 *   interface InviteeContact {          // the stored `invitations.invitee`
 *     readonly kind?: unknown;          // "user" | "email" | "phone"
 *     readonly userId?: unknown;        // also set by the lazy-invite hook (OP-89)
 *     readonly email?: unknown;
 *     readonly phoneE164?: unknown;
 *   }
 *   interface InviteeAccount {          // the signed-in caller
 *     readonly userId: string;
 *     readonly email?: string | null;
 *     readonly phoneE164?: string | null;
 *     readonly emailVerified?: boolean;
 *     readonly phoneNumberVerified?: boolean;
 *   }
 *   type InviteeMatch =
 *     | { readonly matched: false }
 *     | { readonly matched: true; readonly contactVerified: boolean };
 *
 *   matchInvitee(invitee: InviteeContact, account: InviteeAccount): InviteeMatch
 * ```
 *
 * The route maps `{ matched: false }` to `403 invitation_not_for_you` and
 * `{ matched: true, contactVerified: false }` to the unverified-contact `403`
 * (U2-A3). The function is total: it never throws, and an unusable stored
 * invitee simply does not match.
 *
 * ## Assumptions (ADR-0663 §Assumptions)
 *
 * - **U2-A1** — a `user`-kind invitation is `contactVerified: true` by
 *   definition: it names an account id, not a contact, so there is no contact
 *   to verify.
 * - **U2-A2** — an `email`/`phone` invitation whose row also carries the
 *   lazy-invite `invitee.userId` matches that account **or** the contact, but
 *   the verification requirement follows the contact: the invitee must still
 *   hold the verified address.
 * - **U2-A3** — a missing `emailVerified`/`phoneNumberVerified` flag is
 *   **unverified**, never verified.
 * - **U2-A4** — only the separator characters a person types (whitespace,
 *   `-`, `.`, `(`, `)`) are ignored. A number without a leading `+` is not
 *   guessed into E.164, and no digit is dropped.
 */

/** The invitation the organizer addressed to `buck@example.com`. */
const EMAIL_INVITEE = { kind: "email", email: "buck@example.com" } as const;

/** The invitation the organizer addressed to a phone number. */
const PHONE_INVITEE = { kind: "phone", phoneE164: "+919876543210" } as const;

describe("matchInvitee — a `user`-kind invitation names the account itself", () => {
  it("matches the invited account id", () => {
    expect(
      matchInvitee(
        { kind: "user", userId: "6af4a5d3c54a9d9fecf7ca20" },
        { userId: "6af4a5d3c54a9d9fecf7ca20", email: "buck@example.com" }
      )
    ).toEqual({ matched: true, contactVerified: true });
  });

  it("matches the invited id whatever its case", () => {
    expect(
      matchInvitee(
        { kind: "user", userId: "6AF4A5D3C54A9D9FECF7CA20" },
        { userId: "6af4a5d3c54a9d9fecf7ca20" }
      )
    ).toEqual({ matched: true, contactVerified: true });
  });

  it("does not match another account id", () => {
    expect(
      matchInvitee(
        { kind: "user", userId: "6af4a5d3c54a9d9fecf7ca20" },
        { userId: "6af4a5d3c54a9d9fecf7ca21", email: "buck@example.com" }
      )
    ).toEqual({ matched: false });
  });

  it("needs no contact verification for a user-kind invitation (U2-A1)", () => {
    expect(
      matchInvitee(
        { kind: "user", userId: "6af4a5d3c54a9d9fecf7ca20" },
        {
          userId: "6af4a5d3c54a9d9fecf7ca20",
          email: null,
          phoneE164: null,
          emailVerified: false,
          phoneNumberVerified: false,
        }
      )
    ).toEqual({ matched: true, contactVerified: true });
  });
});

describe("matchInvitee — an email invitation matches the address, case-insensitively", () => {
  it("matches an address that differs only in case", () => {
    expect(
      matchInvitee(EMAIL_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        email: "Buck@Example.COM",
        emailVerified: true,
      })
    ).toEqual({ matched: true, contactVerified: true });
  });

  it("matches an address that carries surrounding whitespace", () => {
    expect(
      matchInvitee(EMAIL_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        email: "  buck@example.com ",
        emailVerified: true,
      })
    ).toEqual({ matched: true, contactVerified: true });
  });

  it("does not match a different domain", () => {
    expect(
      matchInvitee(EMAIL_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        email: "buck@example.org",
        emailVerified: true,
      })
    ).toEqual({ matched: false });
  });

  it("does not match an account with no email", () => {
    expect(
      matchInvitee(EMAIL_INVITEE, { userId: "6af4a5d3c54a9d9fecf7ca20", email: null })
    ).toEqual({ matched: false });
  });

  it("reports an unverified matching address as unverified (U2-A3)", () => {
    expect(
      matchInvitee(EMAIL_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        email: "buck@example.com",
        emailVerified: false,
      })
    ).toEqual({ matched: true, contactVerified: false });
  });

  it("reports a matching address with no verification flag as unverified (U2-A3)", () => {
    expect(
      matchInvitee(EMAIL_INVITEE, { userId: "6af4a5d3c54a9d9fecf7ca20", email: "buck@example.com" })
    ).toEqual({ matched: true, contactVerified: false });
  });

  it("matches the account the lazy-invite hook linked to the row (U2-A2)", () => {
    expect(
      matchInvitee(
        { kind: "email", email: "buck@example.com", userId: "6af4a5d3c54a9d9fecf7ca20" },
        { userId: "6af4a5d3c54a9d9fecf7ca20", email: "buck@example.com", emailVerified: true }
      )
    ).toEqual({ matched: true, contactVerified: true });
  });
});

describe("matchInvitee — a phone invitation matches the E.164 digits", () => {
  it("matches a number a person typed with separators", () => {
    expect(
      matchInvitee(PHONE_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        phoneE164: "+91 98765-43210",
        phoneNumberVerified: true,
      })
    ).toEqual({ matched: true, contactVerified: true });
  });

  it("matches a number whose stored form carries the separators", () => {
    expect(
      matchInvitee(
        { kind: "phone", phoneE164: "+91 (98765) 432.10" },
        {
          userId: "6af4a5d3c54a9d9fecf7ca20",
          phoneE164: "+919876543210",
          phoneNumberVerified: true,
        }
      )
    ).toEqual({ matched: true, contactVerified: true });
  });

  it("does not match a different number", () => {
    expect(
      matchInvitee(PHONE_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        phoneE164: "+919876543211",
        phoneNumberVerified: true,
      })
    ).toEqual({ matched: false });
  });

  it("does not guess a country code from a national-format number (U2-A4)", () => {
    expect(
      matchInvitee(PHONE_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        phoneE164: "9876543210",
        phoneNumberVerified: true,
      })
    ).toEqual({ matched: false });
  });

  it("does not match an account with no phone number", () => {
    expect(
      matchInvitee(PHONE_INVITEE, { userId: "6af4a5d3c54a9d9fecf7ca20", phoneE164: null })
    ).toEqual({ matched: false });
  });

  it("reports an unverified matching phone as unverified (U2-A3)", () => {
    expect(
      matchInvitee(PHONE_INVITEE, {
        userId: "6af4a5d3c54a9d9fecf7ca20",
        phoneE164: "+919876543210",
        phoneNumberVerified: false,
      })
    ).toEqual({ matched: true, contactVerified: false });
  });
});

describe("matchInvitee — an unusable stored invitee never matches and never throws", () => {
  it("does not match an unknown invitee kind", () => {
    expect(
      matchInvitee(
        { kind: "carrier-pigeon", email: "buck@example.com" },
        {
          userId: "6af4a5d3c54a9d9fecf7ca20",
          email: "buck@example.com",
          emailVerified: true,
        }
      )
    ).toEqual({ matched: false });
  });

  it("does not match an email invitation whose address is missing", () => {
    expect(
      matchInvitee(
        { kind: "email" },
        {
          userId: "6af4a5d3c54a9d9fecf7ca20",
          email: "buck@example.com",
          emailVerified: true,
        }
      )
    ).toEqual({ matched: false });
  });

  it("does not match a phone invitation whose number is missing", () => {
    expect(
      matchInvitee(
        { kind: "phone" },
        {
          userId: "6af4a5d3c54a9d9fecf7ca20",
          phoneE164: "+919876543210",
          phoneNumberVerified: true,
        }
      )
    ).toEqual({ matched: false });
  });
});
