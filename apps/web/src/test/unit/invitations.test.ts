import { describe, expect, it } from "vitest";

import {
  coOrganizerSeats,
  generateInvitationToken,
  hashInvitationToken,
  invitationByTokenFilter,
  normalizeInvitee,
} from "@/server/collaboration/invitations";
import { sha256Hex } from "@/server/runtime/crypto";

/**
 * Unit — the co-organizer invitation primitives (OP-120 U1–U3, contract §2.3,
 * schema §13.6).
 *
 * The user story: *as an organizer I invite co-organizers by user, email or
 * phone so they can help upload, even before they have an account.* Three
 * decisions carry that story and none of them needs a database, so they are
 * pinned here:
 *
 * - **U1 — invitee normalization.** One `invitee` object is stored per
 *   invitation (§13.6): `{ kind: "user" | "email" | "phone", userId?, email?,
 *   phoneE164? }`. An invite may precede the account, so the stored value is the
 *   canonical contact (lowercase email / E.164 phone / hex user id) — the form
 *   the post-sign-up lazy-invite hook matches on (`@/server/auth/identity-hooks`
 *   compares `invitee.email` and `invitee.phoneE164` **exactly**), which is why
 *   the normalization is a contract and not a nicety.
 * - **U2 — the token hash / lookup.** The raw token travels only inside the
 *   email/SMS link (§2.3: "The raw token is **never** returned"), so the stored
 *   `tokenHash` must be `sha256(rawToken)` and the public preview (§2.3
 *   `GET /api/v1/invitations/{token}`) must look the row up **by that hash**.
 * - **U3 — the entitlement count.** `coorganizers.per_event` is drained by
 *   `eventMembers(active) + invitations(pending)` (§2.3), not by the member rows
 *   alone: a pending invitation already owns the seat, or an organizer could
 *   mail out unbounded invites that all accept later.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/collaboration/invitations
 *   type InviteeInput = { kind: string; userId?: string; email?: string; phoneE164?: string }
 *   type NormalizedInvitee =
 *     | { kind: "user";  userId: string }        // 24 lowercase hex
 *     | { kind: "email"; email: string }         // trimmed, lowercase
 *     | { kind: "phone"; phoneE164: string }     // "+" + digits, E.164 shape
 *   type NormalizeInviteeResult =
 *     | { ok: true;  invitee: NormalizedInvitee }
 *     | { ok: false; code: InviteeProblem; field: string }
 *   type InviteeProblem =
 *     "unknown_kind" | "missing_contact" | "invalid_user_id" | "invalid_email" | "invalid_phone"
 *
 *   normalizeInvitee(input: InviteeInput): NormalizeInviteeResult
 *   hashInvitationToken(rawToken: string): string            // 64 lowercase hex
 *   generateInvitationToken(): string                        // 32 random bytes, base64url
 *   invitationByTokenFilter(rawToken: string): { tokenHash: string }
 *   coOrganizerSeats(input: CoOrganizerSeatInput): number
 *   // CoOrganizerSeatInput = {
 *   //   members:     readonly { role: "organizer" | "co_organizer";
 *   //                           status: "active" | "removed" }[]
 *   //   invitations: readonly { status: string; expiresAt: Date }[]
 *   //   now:         Date
 *   // }
 * ```
 *
 * `normalizeInvitee` returns a **result** rather than throwing, so the naming of
 * a refusal is data the route can put in `details.fields[]` (the crate's
 * `validation_failed` shape). `field` is the request path (`invitee`,
 * `invitee.kind`, `invitee.userId`, `invitee.email`, `invitee.phoneE164`).
 *
 * ## Assumptions (ADR-0660 §Assumptions)
 *
 * - **A1** — normalization is *total*: an email is trimmed and lowercased (the
 *   lazy-invite hook compares it exactly, and mailbox providers treat the domain
 *   case-insensitively), and a phone is stripped of spaces, dashes, dots and
 *   parentheses while keeping a leading `+`. A number without `+` is refused
 *   rather than guessed — the country code is not inferable.
 * - **A2** — a `NormalizedInvitee` carries **exactly** the discriminating `kind`
 *   plus that kind's one contact key. A row that also carried a stale `email`
 *   next to a `userId` would make the lazy-invite `$or` match two accounts.
 * - **A3** — `coOrganizerSeats` counts **every** active event member (the
 *   organizer row included), because §2.3 says `eventMembers(active) +
 *   invitations(pending)` and the organizer is an `event_organizers` row. This is
 *   the literal reading; a lane that wants to exclude the organizer changes §2.3
 *   first.
 * - **A4** — a `pending` invitation whose `expiresAt` is already past does
 *   **not** hold a seat, even before the hourly expiry sweeper flips it to
 *   `expired`: otherwise a lapsing invite blocks the new one for up to an hour,
 *   which the sweeper's own cadence makes possible.
 */

/** A fixed instant, so the "expired" cases cannot flake with the wall clock. */
const NOW = new Date("2026-11-11T10:00:00.000Z");

/** An `expiresAt` comfortably in the future (the schema §13.6 14-day default). */
const LATER = new Date("2026-11-25T10:00:00.000Z");

/** An `expiresAt` in the past. */
const EARLIER = new Date("2026-11-01T10:00:00.000Z");

/** The stored `event_organizers` row the organizer+co-organizer pair produces. */
const ORGANIZER_AND_CO_ORGANIZER = [
  { role: "organizer", status: "active" },
  { role: "co_organizer", status: "active" },
] as const;

/** The stored `event_organizers` row an event starts with. */
const ORGANIZER_ONLY = [{ role: "organizer", status: "active" }] as const;

describe("normalizeInvitee (U1)", () => {
  it("trims and lowercases an email so the lazy-invite hook can match it", () => {
    expect(normalizeInvitee({ kind: "email", email: "  Buck@Example.COM \n" })).toEqual({
      ok: true,
      invitee: { kind: "email", email: "buck@example.com" },
    });
  });

  it("strips spaces and punctuation from a phone while keeping the leading +", () => {
    expect(normalizeInvitee({ kind: "phone", phoneE164: "+91 (98765) 43210" })).toEqual({
      ok: true,
      invitee: { kind: "phone", phoneE164: "+919876543210" },
    });
  });

  it("lowercases a user id, the shape Mongo stores", () => {
    expect(normalizeInvitee({ kind: "user", userId: "6703BBBBBBBBBBBBBBBBBBBB" })).toEqual({
      ok: true,
      invitee: { kind: "user", userId: "6703bbbbbbbbbbbbbbbbbbbb" },
    });
  });

  it("carries exactly the kind and that kind's one contact key", () => {
    const result = normalizeInvitee({
      kind: "email",
      email: "buck@example.com",
      userId: "6703bbbbbbbbbbbbbbbbbbbb",
      phoneE164: "+919876543210",
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? Object.keys(result.invitee).sort() : []).toEqual(["email", "kind"]);
  });

  it("refuses an empty email", () => {
    expect(normalizeInvitee({ kind: "email", email: "   " })).toEqual({
      ok: false,
      code: "invalid_email",
      field: "invitee.email",
    });
  });

  it("refuses an email with no @", () => {
    expect(normalizeInvitee({ kind: "email", email: "buck" })).toEqual({
      ok: false,
      code: "invalid_email",
      field: "invitee.email",
    });
  });

  it("refuses a phone with no leading +, because the country is not inferable", () => {
    expect(normalizeInvitee({ kind: "phone", phoneE164: "919876543210" })).toEqual({
      ok: false,
      code: "invalid_phone",
      field: "invitee.phoneE164",
    });
  });

  it("refuses a phone that still has letters after normalization", () => {
    expect(normalizeInvitee({ kind: "phone", phoneE164: "+91OPS8765432" })).toEqual({
      ok: false,
      code: "invalid_phone",
      field: "invitee.phoneE164",
    });
  });

  it("refuses a user id that is not 24 hex characters", () => {
    expect(normalizeInvitee({ kind: "user", userId: "not-an-object-id" })).toEqual({
      ok: false,
      code: "invalid_user_id",
      field: "invitee.userId",
    });
  });

  it("refuses an email kind with no address", () => {
    expect(normalizeInvitee({ kind: "email" })).toEqual({
      ok: false,
      code: "missing_contact",
      field: "invitee.email",
    });
  });

  it("refuses a phone kind with no number", () => {
    expect(normalizeInvitee({ kind: "phone" })).toEqual({
      ok: false,
      code: "missing_contact",
      field: "invitee.phoneE164",
    });
  });

  it("refuses a user kind with no id", () => {
    expect(normalizeInvitee({ kind: "user" })).toEqual({
      ok: false,
      code: "missing_contact",
      field: "invitee.userId",
    });
  });

  it("refuses a kind outside user|email|phone", () => {
    expect(normalizeInvitee({ kind: "pigeon", email: "buck@example.com" })).toEqual({
      ok: false,
      code: "unknown_kind",
      field: "invitee.kind",
    });
  });
});

describe("hashInvitationToken / invitationByTokenFilter (U2)", () => {
  it("hashes the raw token with sha256, lowercase hex", () => {
    const token = "opaque-token-for-the-hash-pin";

    expect(hashInvitationToken(token)).toBe(sha256Hex(token));
    expect(hashInvitationToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic and never returns the token itself", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);

    expect(hashInvitationToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  it("gives two different tokens two different hashes", () => {
    expect(hashInvitationToken(generateInvitationToken())).not.toBe(
      hashInvitationToken(generateInvitationToken())
    );
  });

  it("mints 32 random bytes as an unpadded base64url token", () => {
    // 32 bytes base64url-encode to 43 characters with no `=` padding.
    expect(generateInvitationToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not repeat a minted token", () => {
    expect(generateInvitationToken()).not.toBe(generateInvitationToken());
  });

  it("looks the invitation up by the hash, so the raw token is never a query value", () => {
    const token = generateInvitationToken();

    expect(invitationByTokenFilter(token)).toEqual({ tokenHash: sha256Hex(token) });
  });
});

describe("coOrganizerSeats (U3)", () => {
  it("is zero for an event with no members and no invitations", () => {
    expect(coOrganizerSeats({ members: [], invitations: [], now: NOW })).toBe(0);
  });

  it("counts the organizer row and an active co-organizer", () => {
    expect(
      coOrganizerSeats({ members: ORGANIZER_AND_CO_ORGANIZER, invitations: [], now: NOW })
    ).toBe(2);
  });

  it("does not count a removed co-organizer", () => {
    expect(
      coOrganizerSeats({
        members: [
          { role: "organizer", status: "active" },
          { role: "co_organizer", status: "removed" },
        ],
        invitations: [],
        now: NOW,
      })
    ).toBe(1);
  });

  it("counts a pending invitation, because the seat is already promised", () => {
    expect(
      coOrganizerSeats({
        members: ORGANIZER_ONLY,
        invitations: [{ status: "pending", expiresAt: LATER }],
        now: NOW,
      })
    ).toBe(2);
  });

  it.each(["accepted", "rejected", "revoked", "expired"])(
    "does not count a %s invitation",
    (status) => {
      expect(
        coOrganizerSeats({
          members: ORGANIZER_ONLY,
          invitations: [{ status, expiresAt: LATER }],
          now: NOW,
        })
      ).toBe(1);
    }
  );

  it("does not count a pending invitation whose window has already closed", () => {
    expect(
      coOrganizerSeats({
        members: ORGANIZER_ONLY,
        invitations: [{ status: "pending", expiresAt: EARLIER }],
        now: NOW,
      })
    ).toBe(1);
  });

  it("sums the active members and the live pending invitations", () => {
    expect(
      coOrganizerSeats({
        members: [
          { role: "organizer", status: "active" },
          { role: "co_organizer", status: "active" },
          { role: "co_organizer", status: "removed" },
        ],
        invitations: [
          { status: "pending", expiresAt: LATER },
          { status: "revoked", expiresAt: LATER },
          { status: "pending", expiresAt: EARLIER },
        ],
        now: NOW,
      })
    ).toBe(3);
  });
});
