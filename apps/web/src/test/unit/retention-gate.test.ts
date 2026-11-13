import { describe, expect, it } from "vitest";

import { requireRetentionOpen, retentionElapsed } from "@/server/attendee/request-event";
import { AppError } from "@/server/http/app-error";

/**
 * Unit — the attendee retention gate the four biometric **writes** share
 * (OP-132 F4-R2b, decision `t_7e4d553b`; contract §6.1, §6.3, §6.5, Appendix A.7;
 * [ADR-0812](../../../../../docs/adr/ADR-0812-op132-attendee-retention-gate.md)).
 *
 * **Why this exists.** `events.retentionExpiresAt` is the attendee-facing window:
 * §6.1 publishes `gallery.open: false` and `gallery.expiredAt` from it, and
 * `resolvePublicEventOutcome` (`@/server/attendee/public-event`) treats it as
 * elapsed **at** the instant, not after it. Nothing read it on the write surface,
 * so a submit that arrives after retention still merited a `selfies` row whose
 * `expireAt` was already in the past: the `selfies_expire_at_ttl` monitor deletes
 * that row, while the `mediaAssets` owner row and the `originals/selfies/<hash>`
 * object it points at have no expiry and no sweep. Those are permanent orphaned
 * biometric bytes.
 *
 * The decision (`t_7e4d553b`, option (a)) is that the four writes **refuse**
 * with `410 gallery_expired` once the deadline has elapsed, so the boundary
 * itself is load-bearing and is pinned here without a database or a request.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/attendee/request-event
 *   retentionElapsed(retentionExpiresAt: Date | null, now: Date): boolean
 *   requireRetentionOpen(window: { readonly retentionExpiresAt: Date | null }, now: Date): void
 * ```
 *
 * - `retentionElapsed` is the pure predicate: `true` exactly when a deadline
 *   exists and `now >= deadline` (inclusive, the §6.1 reading), `false` for a
 *   `null` deadline (an unlimited plan never refuses) and `false` before the
 *   deadline.
 * - `requireRetentionOpen` is the refusal helper the four routes call
 *   immediately after `requireAttendeeScope`: it returns `void` while the window
 *   is open and throws `AppError("gallery_expired")` — **`410`**,
 *   `retryable: false`, `details` exactly `{ expiredAt }` — once it is not. The
 *   `expiredAt` value is `<retentionExpiresAt>.toISOString()`, the identical
 *   string §6.1 publishes as `gallery.expiredAt` (milliseconds included), so a
 *   client can compare the two without parsing either.
 * - The helper takes the **window**, not the whole scope, so the routes pass the
 *   resolved event (`requireRetentionOpen(event, now)`); any object carrying
 *   `retentionExpiresAt` is accepted. `ResolvedEvent` already is one.
 *
 * Equality (`now === retentionExpiresAt`) is pinned **here** only: the
 * integration suite drives real requests through `systemClock`, so it can show
 * elapsed and open windows but cannot land on the millisecond.
 *
 * ## Assumptions (ADR-0812 §Assumptions)
 *
 * - A1 — the deadline is compared as an instant, not as a calendar day: a
 *   `retentionExpiresAt` of `…T18:00:00.123Z` is elapsed at exactly that
 *   millisecond, whatever the display time zone.
 * - A2 — the predicate never mutates or normalises its inputs; the same `Date`
 *   is echoed in `details.expiredAt`.
 */

/** The retention deadline the cases measure against (a non-zero millisecond). */
const RETENTION = new Date("2027-02-14T18:00:00.123Z");

/** One millisecond, the finest step the boundary admits. */
const ONE_MS = 1;

/**
 * Run `run` and return what it threw, failing when it returned normally.
 *
 * @param run - The call under test.
 * @returns The thrown value.
 */
function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, but it returned");
}

/* ─────────────────── U1: the inclusive elapsed predicate ─────────────────── */

describe("U1 — retentionElapsed is inclusive at the retention instant", () => {
  it("never reports an unlimited event (a null deadline) as elapsed", () => {
    expect(retentionElapsed(null, RETENTION)).toBe(false);
  });

  it("reports the window open one millisecond before the deadline", () => {
    const justBefore = new Date(RETENTION.getTime() - ONE_MS);

    expect(retentionElapsed(RETENTION, justBefore)).toBe(false);
  });

  it("reports the window elapsed at the deadline itself", () => {
    expect(retentionElapsed(RETENTION, RETENTION)).toBe(true);
  });

  it("reports the window elapsed one millisecond after the deadline", () => {
    const justAfter = new Date(RETENTION.getTime() + ONE_MS);

    expect(retentionElapsed(RETENTION, justAfter)).toBe(true);
  });
});

/* ────────── U2: the refusal the four write routes share is 410 ───────────── */

describe("U2 — requireRetentionOpen refuses an elapsed window with 410 gallery_expired", () => {
  it("throws 410 gallery_expired carrying the deadline as details.expiredAt", () => {
    const thrown = caught(() => {
      requireRetentionOpen({ retentionExpiresAt: RETENTION }, RETENTION);
    });

    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe("gallery_expired");
    expect(error.status).toBe(410);
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ expiredAt: RETENTION.toISOString() });
  });

  it("carries the deadline with milliseconds, exactly as §6.1 publishes gallery.expiredAt", () => {
    const thrown = caught(() => {
      requireRetentionOpen(
        { retentionExpiresAt: RETENTION },
        new Date(RETENTION.getTime() + ONE_MS)
      );
    });

    const expiredAt = (thrown as AppError).details?.expiredAt;

    expect(expiredAt).toBe("2027-02-14T18:00:00.123Z");
  });

  it("returns while the window is still open", () => {
    expect(() => {
      requireRetentionOpen(
        { retentionExpiresAt: RETENTION },
        new Date(RETENTION.getTime() - ONE_MS)
      );
    }).not.toThrow();
  });

  it("returns for an unlimited event", () => {
    expect(() => {
      requireRetentionOpen({ retentionExpiresAt: null }, RETENTION);
    }).not.toThrow();
  });
});
