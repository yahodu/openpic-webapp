import { describe, expect, it } from "vitest";

import { decideTerminalOutcome } from "@/server/collaboration/invitation-decision";

/**
 * Unit — the terminal-state → response mapper for one invitation decision
 * (OP-121 U1, contract §2.3, notification §7).
 *
 * The user story: *as an invitee, I want accept/reject to be final and
 * idempotent across email, SMS and in-app so that double clicks or
 * cross-channel clicks never error.* The whole story rests on **one** rule
 * (§2.3 rules 1–2): every terminal transition is a single conditional
 * `findOneAndUpdate` filtered on `status: "pending"` **and**
 * `expiresAt: { $gt: now }`. When that write matches nothing, the row is
 * already terminal, and the endpoint must answer from the row's current state —
 * `200` for `accepted`/`rejected` (the decision is final), `410` for
 * `revoked`/`expired` (the affordance must disappear). Never `409`.
 *
 * That decision is pure: it needs the stored row and one instant, nothing else.
 * The routes therefore share it, so the email path, the SMS path and the in-app
 * path cannot disagree about what a second click means.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/collaboration/invitation-decision
 *   interface DecisionRow {
 *     readonly status?: unknown;      // "pending" | "accepted" | "rejected" | "revoked" | "expired"
 *     readonly expiresAt?: unknown;   // Date (the row's decision deadline)
 *     readonly resolvedVia?: unknown; // the channel that won the decision
 *     readonly resolvedAt?: unknown;  // when it won
 *     readonly revokedAt?: unknown;   // when the organizer revoked it
 *   }
 *
 *   type TerminalOutcome =
 *     | { kind: "pending" }   // live `pending` row: the conditional lost a race, retry
 *     | { kind: "already_resolved"; status: "accepted" | "rejected";
 *         resolvedVia: string; resolvedAt: Date }
 *     | { kind: "revoked"; revokedAt: Date | null }
 *     | { kind: "expired"; expiredAt: Date | null };
 *
 *   decideTerminalOutcome(row: DecisionRow, now: Date): TerminalOutcome
 * ```
 *
 * Mapped to the wire by the route: `already_resolved` is `200` with
 * `alreadyResolved: true`; `revoked` is `410 invitation_revoked`; `expired` is
 * `410 invitation_expired`; `pending` means the writer lost a race and must
 * re-read (never a `409`).
 *
 * ## Assumptions (ADR-0663 §Assumptions)
 *
 * - **U1-A1** — an `accepted`/`rejected` row that carries no `resolvedVia`
 *   (data written before the field existed) reads as `"in_app"`: the client
 *   needs *a* channel to render, and the in-app path is the default surface.
 * - **U1-A2** — an `accepted`/`rejected` row that carries no `resolvedAt` reads
 *   as `now`, so the replay body always has an ISO instant to render.
 * - **U1-A3** — the expiry boundary is strict: the transition filter is
 *   `expiresAt > now`, so a row whose deadline **is** `now` can no longer be
 *   accepted and reads as `expired`.
 * - **U1-A4** — a `pending` row whose `expiresAt` is missing or unreadable is
 *   `expired` (fail closed): an invitation whose window cannot be evaluated
 *   must not be acceptable.
 * - **U1-A5** — a status outside the five §13.6 values is corrupt data, so the
 *   mapper **throws** (the route answers `500`) instead of inventing a
 *   decision.
 */

/** The instant the mapper is asked about, fixed so no case reads the clock. */
const NOW = new Date("2026-09-25T09:14:00.000Z");

describe("decideTerminalOutcome — the accepted/rejected replay (§2.3 rule 2)", () => {
  it("reads an accepted row as already resolved and echoes the winning channel", () => {
    const outcome = decideTerminalOutcome(
      {
        status: "accepted",
        expiresAt: new Date("2026-10-09T09:00:00.000Z"),
        resolvedVia: "email",
        resolvedAt: new Date("2026-09-25T08:00:00.000Z"),
      },
      NOW
    );

    expect(outcome).toEqual({
      kind: "already_resolved",
      status: "accepted",
      resolvedVia: "email",
      resolvedAt: new Date("2026-09-25T08:00:00.000Z"),
    });
  });

  it("reads a rejected row as already resolved with its own status", () => {
    const outcome = decideTerminalOutcome(
      {
        status: "rejected",
        expiresAt: new Date("2026-10-09T09:00:00.000Z"),
        resolvedVia: "sms",
        resolvedAt: new Date("2026-09-25T08:30:00.000Z"),
      },
      NOW
    );

    expect(outcome).toEqual({
      kind: "already_resolved",
      status: "rejected",
      resolvedVia: "sms",
      resolvedAt: new Date("2026-09-25T08:30:00.000Z"),
    });
  });

  it("echoes a channel it does not know rather than coercing it (U1-A1)", () => {
    const outcome = decideTerminalOutcome(
      { status: "accepted", resolvedVia: "whatsapp", resolvedAt: new Date() },
      NOW
    );

    expect(outcome).toMatchObject({ kind: "already_resolved", resolvedVia: "whatsapp" });
  });

  it("defaults a missing resolvedVia to in_app (U1-A1)", () => {
    const outcome = decideTerminalOutcome(
      { status: "accepted", resolvedAt: new Date("2026-09-25T08:00:00.000Z") },
      NOW
    );

    expect(outcome).toMatchObject({ kind: "already_resolved", resolvedVia: "in_app" });
  });

  it("substitutes the asked instant when the row has no resolvedAt (U1-A2)", () => {
    const outcome = decideTerminalOutcome({ status: "accepted", resolvedVia: "email" }, NOW);

    expect(outcome).toMatchObject({ kind: "already_resolved", resolvedAt: NOW });
  });
});

describe("decideTerminalOutcome — revoked and expired are structurally unacceptable (§2.3 rule 4)", () => {
  it("reads a revoked row as revoked with the revocation instant", () => {
    const revokedAt = new Date("2026-09-24T12:00:00.000Z");

    expect(
      decideTerminalOutcome(
        { status: "revoked", expiresAt: new Date("2026-10-09T09:00:00.000Z"), revokedAt },
        NOW
      )
    ).toEqual({ kind: "revoked", revokedAt });
  });

  it("reads a revoked row without a revocation instant as revoked with null", () => {
    expect(decideTerminalOutcome({ status: "revoked" }, NOW)).toEqual({
      kind: "revoked",
      revokedAt: null,
    });
  });

  it("reads an expired row as expired with its own deadline", () => {
    const expiresAt = new Date("2026-09-01T09:00:00.000Z");

    expect(decideTerminalOutcome({ status: "expired", expiresAt }, NOW)).toEqual({
      kind: "expired",
      expiredAt: expiresAt,
    });
  });

  it("reads a pending row past its deadline as expired, not pending", () => {
    const expiresAt = new Date("2026-09-25T09:13:59.999Z");

    expect(decideTerminalOutcome({ status: "pending", expiresAt }, NOW)).toEqual({
      kind: "expired",
      expiredAt: expiresAt,
    });
  });

  it("reads a pending row whose deadline is exactly now as expired (U1-A3)", () => {
    expect(decideTerminalOutcome({ status: "pending", expiresAt: NOW }, NOW)).toEqual({
      kind: "expired",
      expiredAt: NOW,
    });
  });

  it("reads a pending row with no deadline as expired (U1-A4)", () => {
    expect(decideTerminalOutcome({ status: "pending" }, NOW)).toEqual({
      kind: "expired",
      expiredAt: null,
    });
  });

  it("reads a pending row with an unreadable deadline as expired (U1-A4)", () => {
    expect(decideTerminalOutcome({ status: "pending", expiresAt: "soon" }, NOW)).toEqual({
      kind: "expired",
      expiredAt: null,
    });
  });
});

describe("decideTerminalOutcome — a live pending row is a lost race, never a decision", () => {
  it("reads a pending row before its deadline as pending", () => {
    expect(
      decideTerminalOutcome(
        { status: "pending", expiresAt: new Date("2026-09-25T09:14:00.001Z") },
        NOW
      )
    ).toEqual({ kind: "pending" });
  });

  it("throws for a status outside the §13.6 lifecycle (U1-A5)", () => {
    expect(() => decideTerminalOutcome({ status: "archived" }, NOW)).toThrow(/archived/);
  });

  it("throws for a row with no status at all (U1-A5)", () => {
    expect(() => decideTerminalOutcome({}, NOW)).toThrow(/status/);
  });
});
