import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RIVAL_COMMIT_POLL_MS,
  RIVAL_COMMIT_TIMEOUT_MS,
  waitForCommitted,
} from "@/server/db/retry-wait";

/**
 * Unit — the bounded wait a loser of a write race uses (OP-121, ADR-0670).
 *
 * `waitForCommitted(read, isSettled)` polls `read` until `isSettled` accepts a
 * row, bounded by `RIVAL_COMMIT_TIMEOUT_MS`. The refactor this record's §Context
 * describes made the ceiling exact: polls are taken at `0, 25, … 1_000` ms —
 * **41 reads** — and the loop sleeps only when another poll follows, so the
 * last check lands **at** the ceiling instead of one interval past it. Until
 * this spec the property lived only in the module's docblock and in that
 * record: re-inserting the trailing `sleep` (the pre-refactor loop,
 * `≈1 025 ms` of sleep) left every shipped spec green, so a revert of the fix
 * was invisible.
 *
 * ## Contract expected of the implementation
 *
 * ```
 * @/server/db/retry-wait
 *   RIVAL_COMMIT_TIMEOUT_MS: 1_000   // the ceiling on the wait
 *   RIVAL_COMMIT_POLL_MS: 25         // the linear poll interval
 *   waitForCommitted<T>(read: () => Promise<T>, isSettled: (row: T) => boolean): Promise<boolean>
 * ```
 *
 * - A poll is taken **first**, before any sleep, so a row that is already
 *   settled costs one read and no timer.
 * - Reads are one per interval while the row is unsettled, so the read count
 *   is `RIVAL_COMMIT_TIMEOUT_MS / RIVAL_COMMIT_POLL_MS + 1` = `41`.
 * - The promise **resolves** at the ceiling (`true` once settled, `false` when
 *   it never was) and leaves no poll scheduled — the ceiling bounds the wait,
 *   not the poll count.
 *
 * ## Why fake timers
 *
 * The pin measures a schedule, not a wall clock: `vi.useFakeTimers()` plus
 * `vi.advanceTimersByTimeAsync(...)` drives the sleeps deterministically, so the
 * spec cannot flake on host load and cannot be satisfied by a loop that happens
 * to answer within a real-time tolerance. The assertions are the read count and
 * the resolution inside the ceiling, never elapsed milliseconds.
 */
const EXPECTED_READS = RIVAL_COMMIT_TIMEOUT_MS / RIVAL_COMMIT_POLL_MS + 1;

describe("waitForCommitted", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pins the documented 1 000 ms ceiling, the 25 ms poll and the 41-read schedule", () => {
    expect(RIVAL_COMMIT_TIMEOUT_MS).toBe(1_000);
    expect(RIVAL_COMMIT_POLL_MS).toBe(25);
    expect(EXPECTED_READS).toBe(41);
  });

  describe("when the row never settles", () => {
    it("takes one read per poll interval, the first without waiting", async () => {
      vi.useFakeTimers();
      const read = vi.fn(() => Promise.resolve(null));

      const promise = waitForCommitted(read, () => false);

      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(RIVAL_COMMIT_POLL_MS - 1);
      expect(read).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(RIVAL_COMMIT_TIMEOUT_MS);
      await expect(promise).resolves.toBe(false);
    });

    it("takes 41 reads, the last one at the ceiling", async () => {
      vi.useFakeTimers();
      const read = vi.fn(() => Promise.resolve(null));

      const promise = waitForCommitted(read, () => false);

      await vi.advanceTimersByTimeAsync(RIVAL_COMMIT_TIMEOUT_MS);
      expect(read).toHaveBeenCalledTimes(EXPECTED_READS);

      // Let the loop settle for teardown. The resolution *at* the ceiling is the
      // next case's assertion; this one pins the read count at that instant.
      await vi.advanceTimersByTimeAsync(RIVAL_COMMIT_TIMEOUT_MS);
      await expect(promise).resolves.toBe(false);
    });

    it("answers false inside the ceiling and leaves no poll timer pending", async () => {
      vi.useFakeTimers();
      const read = vi.fn(() => Promise.resolve(null));
      let outcome: boolean | undefined;
      const promise = waitForCommitted(read, () => false).then((settled) => {
        outcome = settled;
        return settled;
      });

      await vi.advanceTimersByTimeAsync(RIVAL_COMMIT_TIMEOUT_MS);

      // The discriminating half: a trailing sleep would still hold a 41st timer
      // at the ceiling and leave the promise unresolved here.
      expect(vi.getTimerCount()).toBe(0);
      await Promise.resolve();
      expect(outcome).toBe(false);

      await expect(promise).resolves.toBe(false);
    });
  });

  describe("when the row settles on the last poll", () => {
    it("returns true from the 41st read, without waiting past the ceiling", async () => {
      vi.useFakeTimers();
      let readsTaken = 0;
      const read = vi.fn(() => {
        readsTaken += 1;
        return Promise.resolve(readsTaken);
      });
      let outcome: boolean | undefined;
      const promise = waitForCommitted(read, (row) => row === EXPECTED_READS).then((settled) => {
        outcome = settled;
        return settled;
      });

      await vi.advanceTimersByTimeAsync(RIVAL_COMMIT_TIMEOUT_MS - RIVAL_COMMIT_POLL_MS);
      expect(read).toHaveBeenCalledTimes(EXPECTED_READS - 1);
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(RIVAL_COMMIT_POLL_MS);
      expect(read).toHaveBeenCalledTimes(EXPECTED_READS);
      expect(vi.getTimerCount()).toBe(0);

      await expect(promise).resolves.toBe(true);
    });
  });

  describe("when the row is already settled", () => {
    it("returns true after one read without scheduling a timer", async () => {
      vi.useFakeTimers();
      const read = vi.fn(() => Promise.resolve("committed"));

      await expect(waitForCommitted(read, () => true)).resolves.toBe(true);

      expect(read).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
