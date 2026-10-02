import { afterEach, describe, expect, it, vi } from "vitest";

import { fixedClock, systemClock } from "./clock";

/**
 * Contract under test — the `Clock` port (OP-72, epic Runtime Primitives).
 *
 * `src/server/runtime/clock.ts` must expose:
 *
 *   - `Clock` — `{ now(): Date }`.
 *   - `systemClock` — reads the process wall clock.
 *   - `fixedClock(start, stepMs?)` — a deterministic clock whose first `now()`
 *     returns `start` and whose every subsequent read advances by `stepMs`
 *     (default `0`, i.e. frozen).
 */

describe("fixedClock", () => {
  it("U8: advances by the fixed step on every read, deterministically", () => {
    const clock = fixedClock("2026-01-02T03:04:05.000Z", 1000);

    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:06.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:07.000Z");
  });

  it("U8: stays frozen when no step is given", () => {
    const clock = fixedClock("2026-01-02T03:04:05.000Z");

    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("U8: starts two clocks independently (no shared cursor)", () => {
    const first = fixedClock("2026-01-02T03:04:05.000Z", 1000);
    const second = fixedClock("2026-01-02T03:04:05.000Z", 1000);

    expect(first.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(first.now().toISOString()).toBe("2026-01-02T03:04:06.000Z");
    expect(second.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("U8: accepts a Date and a millisecond epoch number as the start", () => {
    const fromDate = fixedClock(new Date("2026-01-02T03:04:05.000Z"));
    const fromEpoch = fixedClock(Date.parse("2026-01-02T03:04:05.000Z"));

    expect(fromDate.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(fromEpoch.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("U8: does not mutate the Date passed in as the start", () => {
    const start = new Date("2026-01-02T03:04:05.000Z");
    const clock = fixedClock(start, 1000);

    clock.now();

    expect(start.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("systemClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the process wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));

    expect(systemClock.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
});
