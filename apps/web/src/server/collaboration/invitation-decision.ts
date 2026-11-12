/**
 * The terminal-state mapper for one invitation decision (OP-121, contract §2.3
 * rules 2 and 4, schema §13.6).
 *
 * Every decision endpoint first attempts **one** conditional transition
 * (`status: "pending"` and `expiresAt > now`). When that write matches nothing
 * the row is already terminal, and the answer must come from the row's current
 * state — never from a `409`. This module owns that reading so the email, SMS
 * and in-app paths cannot disagree about what a second click means.
 *
 * It is pure: the row and the instant are the only inputs.
 */

/** The `invitations` fields the mapper reads (schema §13.6). */
export interface DecisionRow {
  /** `pending` | `accepted` | `rejected` | `revoked` | `expired`. */
  readonly status?: unknown;
  /** The row's decision deadline. */
  readonly expiresAt?: unknown;
  /** The channel that won the decision. */
  readonly resolvedVia?: unknown;
  /** When the decision won. */
  readonly resolvedAt?: unknown;
  /** When the organizer revoked the invitation. */
  readonly revokedAt?: unknown;
}

/** What a row means once its transition matched nothing. */
export type TerminalOutcome =
  | { readonly kind: "pending" }
  | {
      readonly kind: "already_resolved";
      readonly status: "accepted" | "rejected";
      readonly resolvedVia: string;
      readonly resolvedAt: Date;
    }
  | { readonly kind: "revoked"; readonly revokedAt: Date | null }
  | { readonly kind: "expired"; readonly expiredAt: Date | null };

/** The channel the in-app path records when the row carries none (U1-A1). */
const DEFAULT_RESOLVED_VIA = "in_app";

/**
 * Read a stored instant, or `null` when it is missing or unreadable.
 *
 * @param value - The stored value.
 * @returns The instant, or `null`.
 */
function instantOrNull(value: unknown): Date | null {
  return value instanceof Date ? value : null;
}

/**
 * Map one stored row onto the answer its decision endpoint must give.
 *
 * @param row - The stored `invitations` document.
 * @param now - The instant the decision is judged at.
 * @returns `pending` when the conditional write lost a race (re-read, never
 *   `409`), `already_resolved` for a final decision, `revoked` / `expired` for
 *   the two structurally unacceptable states.
 * @throws When `status` is outside the §13.6 lifecycle — corrupt data must not
 *   be answered with an invented decision.
 */
export function decideTerminalOutcome(row: DecisionRow, now: Date): TerminalOutcome {
  switch (row.status) {
    case "accepted":
    case "rejected": {
      const resolvedVia = row.resolvedVia;
      return {
        kind: "already_resolved",
        status: row.status,
        resolvedVia: typeof resolvedVia === "string" ? resolvedVia : DEFAULT_RESOLVED_VIA,
        resolvedAt: instantOrNull(row.resolvedAt) ?? now,
      };
    }
    case "revoked":
      return { kind: "revoked", revokedAt: instantOrNull(row.revokedAt) };
    case "expired":
      return { kind: "expired", expiredAt: instantOrNull(row.expiresAt) };
    case "pending": {
      // The transition filter is strict (`expiresAt > now`), so a deadline that
      // is `now` — or missing, or unreadable — can no longer be accepted (U1-A3,
      // U1-A4: fail closed).
      const expiresAt = instantOrNull(row.expiresAt);
      if (expiresAt !== null && expiresAt.getTime() > now.getTime()) {
        return { kind: "pending" };
      }
      return { kind: "expired", expiredAt: expiresAt };
    }
    default:
      throw new Error(`invitation has an unknown status: ${String(row.status)}`);
  }
}
