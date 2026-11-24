import { vi } from "vitest";

/**
 * The fake-`Date` seam for integration specs (ADR-0973, class ADR-0148).
 *
 * **Why this exists.** A spec that wants a persisted row to be *lapsed* has two
 * ways to say so, and they are not equivalent. Stamping the row's `expireAt`
 * into the **real past** puts it in the MongoDB TTL monitor's selection set:
 * `attendee_sessions_expire_at_ttl` (`{expireAt: 1}`, `expireAfterSeconds: 0`)
 * is evaluated against the real wall clock on a ~60 s pass, so the row is
 * deleted at an instant the spec cannot control — and whenever the answer
 * depends on the row it changes from the pinned one to the absent-row one. That
 * is the class [`ADR-0148`](../../../../../docs/adr/ADR-0148-integration-fixture-clock-anchor.md)
 * names, and the shape the claim suite's `I2` repair measured and adopted before
 * this helper existed.
 *
 * The other way is to keep the row **live** (`expireAt` in the real future, so
 * the monitor can never select it) and move the *reader's* clock past it. That
 * is this helper: the answer becomes a function of one clock read, not of when
 * a background pass happened to run.
 *
 * It fakes **only** `Date`, so `systemClock.now()` (`new Date()` per call) is
 * the value that moves while timers, the Mongo driver's heartbeats and the
 * readiness polls keep their real scheduling. The instant is restored in a
 * `finally`, so a throwing assertion cannot leak the fake clock into the next
 * case of the file.
 *
 * Prefer this over any inline `vi.useFakeTimers` in a spec: one seam, one
 * place to reason about. A case that only needs the row to stay unswept (an
 * answer that asserts a `200` for a live credential) needs no clock move at all
 * — a real-future `expireAt` is enough.
 *
 * @param instant - The instant every `Date` read inside `fn` reports.
 * @param fn - The request (or request sequence) to run under that instant.
 * @returns Whatever `fn` resolves to.
 * @example
 * ```ts
 * const expiresAt = new Date(Date.now() + 60_000); // the TTL monitor cannot select it
 * const response = await withClockAt(expiresAt, () =>
 *   currentSession({ "x-attendee-session": token })
 * );
 * expect(parsed.error.code).toBe("attendee_session_expired");
 * ```
 */
export async function withClockAt<T>(instant: Date, fn: () => Promise<T> | T): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(instant);
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
