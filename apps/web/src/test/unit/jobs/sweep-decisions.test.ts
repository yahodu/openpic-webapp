import { describe, expect, it } from "vitest";

import { incrementalMatchRunKey } from "@/server/attendee/match-run";
import { matchesNewDedupeKey } from "@/server/domain/domain-events";
import {
  RETENTION_STEPS,
  nextEraseStep,
  resolveEventStatus,
  retentionWarningPoint,
  uploadWindowPoint,
  usageThresholdsToNotify,
  verificationNudgePoint,
} from "@/server/jobs/sweep-decisions";

/**
 * Unit — the pure decisions of the OP-136 background jobs (contract §10.2,
 * §10.3.3; schema §15.1, §15.3, §22; ADR-0849).
 *
 * Every cron in this lane is "find the rows whose instant has arrived, do one
 * conditional write". The instant arithmetic, the latches and the ordered
 * erasure sequence are the parts a reviewer cannot read off a query, so they
 * live in one pure module and this file is its executable specification. No
 * database, no clock, no logger: every input carries its own instant.
 *
 * ## The module contract this file pins
 *
 * `@/server/jobs/sweep-decisions` exports:
 *
 * - `uploadWindowPoint({ uploadWindowEndsAt, now })` → `"t-72h" | "t-24h" |
 *   "closed" | null`;
 * - `retentionWarningPoint({ retentionExpiresAt, now, audience })` → `"t-14d" |
 *   "t-7d" | "t-3d" | "t-1d" | null` (organizer points are T-14d/T-3d, attendee
 *   points T-7d/T-1d);
 * - `resolveEventStatus({ status, startAt, endAt, now })` → `"live" | "ended" |
 *   null`;
 * - `usageThresholdsToNotify({ percent, latched })` → `readonly number[]`
 *   (ascending);
 * - `nextEraseStep(marker)` → `RetentionStep | null`, where `RetentionStep` is
 *   a member of `RETENTION_STEPS`;
 * - `verificationNudgePoint({ createdAt, completed, nudgesSent, now })` →
 *   `"t+24h" | "t+72h" | null`.
 *
 * `@/server/attendee/match-run` exports `incrementalMatchRunKey({ eventId,
 * profileId, selfieId, runAt })` → the second, run-discriminated delivery
 * identity ADR-0808 §3 requires.
 *
 * ## The fire-window rule (the card's "boundary ± one run interval")
 *
 * A schedule point at instant `P` is **due** while `P <= now < P + runInterval`
 * where the interval is the job's own cadence (1 h for the hourly sweeps, 24 h
 * for the daily ones). So the exact boundary fires, one interval later is a
 * different (or no) point, and one millisecond before is silent. A weekly run
 * that drifts by minutes therefore still fires exactly once, and a run that is
 * a whole interval late cannot fire the wrong point's message.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The upload window the window-point rows reason about. */
const WINDOW_ENDS = new Date("2026-12-01T00:00:00.000Z");

describe("uploadWindowPoint", () => {
  it.each([
    { case: "1 ms before T-72h", now: "2026-11-27T23:59:59.999Z", expected: null },
    { case: "exactly T-72h", now: "2026-11-28T00:00:00.000Z", expected: "t-72h" },
    { case: "1 min after T-72h", now: "2026-11-28T00:01:00.000Z", expected: "t-72h" },
    { case: "one run interval after T-72h", now: "2026-11-28T01:00:00.000Z", expected: null },
    { case: "1 interval before T-24h", now: "2026-11-29T23:00:00.000Z", expected: null },
    { case: "exactly T-24h", now: "2026-11-30T00:00:00.000Z", expected: "t-24h" },
    { case: "1 min after T-24h", now: "2026-11-30T00:01:00.000Z", expected: "t-24h" },
    { case: "one run interval after a point", now: "2026-11-30T01:00:00.000Z", expected: null },
    { case: "exactly at the deadline", now: "2026-12-01T00:00:00.000Z", expected: "closed" },
    { case: "two days after the deadline", now: "2026-12-03T00:00:00.000Z", expected: "closed" },
  ])("answers $expected for $case", ({ now, expected }) => {
    expect(uploadWindowPoint({ uploadWindowEndsAt: WINDOW_ENDS, now: new Date(now) })).toBe(
      expected
    );
  });

  it("is silent for an event whose upload window is unlimited", () => {
    expect(uploadWindowPoint({ uploadWindowEndsAt: null, now: WINDOW_ENDS })).toBeNull();
  });

  it("does not read the wall clock: two runs one interval apart answer different points", () => {
    const atPoint = uploadWindowPoint({
      uploadWindowEndsAt: WINDOW_ENDS,
      now: new Date(WINDOW_ENDS.getTime() - 24 * HOUR_MS),
    });
    const nextRun = uploadWindowPoint({
      uploadWindowEndsAt: WINDOW_ENDS,
      now: new Date(WINDOW_ENDS.getTime() - 23 * HOUR_MS),
    });

    expect([atPoint, nextRun]).toEqual(["t-24h", null]);
  });
});

describe("retentionWarningPoint", () => {
  const RETENTION = new Date("2026-12-01T00:00:00.000Z");
  const organizerAt = (days: number): Date => new Date(RETENTION.getTime() - days * DAY_MS);

  it.each([
    { case: "organizer 1 ms before T-14d", now: organizerAt(14).getTime() - 1, expected: null },
    {
      case: "organizer exactly at T-14d",
      now: organizerAt(14).getTime(),
      expected: "t-14d",
    },
    {
      case: "organizer 12 h into the T-14d day",
      now: organizerAt(14).getTime() + 12 * HOUR_MS,
      expected: "t-14d",
    },
    {
      case: "organizer one day after T-14d",
      now: organizerAt(14).getTime() + DAY_MS,
      expected: null,
    },
    { case: "organizer 1 ms before T-3d", now: organizerAt(3).getTime() - 1, expected: null },
    { case: "organizer exactly at T-3d", now: organizerAt(3).getTime(), expected: "t-3d" },
    {
      case: "organizer 23 h into the T-3d day",
      now: organizerAt(3).getTime() + 23 * HOUR_MS,
      expected: "t-3d",
    },
    {
      case: "organizer one day after T-3d",
      now: organizerAt(3).getTime() + DAY_MS,
      expected: null,
    },
  ])("answers $expected for the $case", ({ now, expected }) => {
    expect(
      retentionWarningPoint({
        retentionExpiresAt: RETENTION,
        now: new Date(now),
        audience: "organizer",
      })
    ).toBe(expected);
  });

  it.each([
    {
      case: "attendee 1 ms before T-7d",
      now: new Date(RETENTION.getTime() - 7 * DAY_MS).getTime() - 1,
      expected: null,
    },
    {
      case: "attendee exactly at T-7d",
      now: new Date(RETENTION.getTime() - 7 * DAY_MS).getTime(),
      expected: "t-7d",
    },
    {
      case: "attendee 23 h into the T-7d day",
      now: new Date(RETENTION.getTime() - 7 * DAY_MS).getTime() + 23 * HOUR_MS,
      expected: "t-7d",
    },
    {
      case: "attendee one day after T-7d",
      now: new Date(RETENTION.getTime() - 7 * DAY_MS).getTime() + DAY_MS,
      expected: null,
    },
    {
      case: "attendee 1 ms before T-1d",
      now: new Date(RETENTION.getTime() - DAY_MS).getTime() - 1,
      expected: null,
    },
    {
      case: "attendee exactly at T-1d",
      now: new Date(RETENTION.getTime() - DAY_MS).getTime(),
      expected: "t-1d",
    },
    {
      case: "attendee one day after T-1d",
      now: RETENTION.getTime(),
      expected: null,
    },
  ])("answers $expected for the $case", ({ now, expected }) => {
    expect(
      retentionWarningPoint({
        retentionExpiresAt: RETENTION,
        now: new Date(now),
        audience: "attendee",
      })
    ).toBe(expected);
  });

  it("keeps the two audiences' points disjoint", () => {
    const atT7d = new Date(RETENTION.getTime() - 7 * DAY_MS);

    expect(
      retentionWarningPoint({ retentionExpiresAt: RETENTION, now: atT7d, audience: "organizer" })
    ).toBeNull();
    expect(
      retentionWarningPoint({ retentionExpiresAt: RETENTION, now: atT7d, audience: "attendee" })
    ).toBe("t-7d");
  });

  it("is silent for an event whose retention is unlimited", () => {
    expect(
      retentionWarningPoint({ retentionExpiresAt: null, now: RETENTION, audience: "organizer" })
    ).toBeNull();
  });
});

describe("resolveEventStatus", () => {
  const START = new Date("2026-11-20T18:00:00.000Z");
  const END = new Date("2026-11-21T02:00:00.000Z");

  it.each([
    {
      case: "published 1 ms before startAt",
      status: "published",
      now: new Date(START.getTime() - 1),
      expected: null,
    },
    { case: "published exactly at startAt", status: "published", now: START, expected: "live" },
    {
      case: "published between start and end",
      status: "published",
      now: new Date(START.getTime() + HOUR_MS),
      expected: "live",
    },
    {
      case: "live exactly at endAt",
      status: "live",
      now: END,
      expected: "ended",
    },
    {
      case: "published already past endAt",
      status: "published",
      now: new Date(END.getTime() + 1),
      expected: "ended",
    },
  ])("answers $expected for $case", ({ status, now, expected }) => {
    expect(resolveEventStatus({ status, startAt: START, endAt: END, now })).toBe(expected);
  });

  it.each([
    {
      case: "a live event before its end",
      status: "live",
      now: new Date(START.getTime() + 2 * HOUR_MS),
    },
    { case: "an ended event", status: "ended", now: new Date(END.getTime() + DAY_MS) },
    { case: "a draft", status: "draft", now: new Date(START.getTime() + HOUR_MS) },
    { case: "an archived event", status: "archived", now: new Date(END.getTime() + DAY_MS) },
    { case: "an event being deleted", status: "deleting", now: new Date(END.getTime() + DAY_MS) },
  ])("never rewrites $case", ({ status, now }) => {
    expect(resolveEventStatus({ status, startAt: START, endAt: END, now })).toBeNull();
  });
});

describe("usageThresholdsToNotify", () => {
  it.each([
    { case: "1 % under the first threshold", percent: 79, latched: [] as number[], expected: [] },
    { case: "exactly 80 %", percent: 80, latched: [] as number[], expected: [80] },
    { case: "84.9 %", percent: 84.9, latched: [] as number[], expected: [80] },
    { case: "exactly 95 %", percent: 95, latched: [] as number[], expected: [80, 95] },
    { case: "exactly 100 %", percent: 100, latched: [] as number[], expected: [80, 95, 100] },
    { case: "over 100 %", percent: 140, latched: [] as number[], expected: [80, 95, 100] },
    { case: "80 % already latched", percent: 82, latched: [80], expected: [] },
    { case: "80 % latched, 96 % crossed", percent: 96, latched: [80], expected: [95] },
    { case: "every threshold latched", percent: 100, latched: [80, 95, 100], expected: [] },
  ])("answers $expected for $case", ({ percent, latched, expected }) => {
    expect(usageThresholdsToNotify({ percent, latched })).toEqual(expected);
  });

  it("answers nothing for an unlimited quota", () => {
    expect(usageThresholdsToNotify({ percent: null, latched: [] })).toEqual([]);
  });

  it("does not re-notify a threshold that is re-crossed after a drop in the same period", () => {
    const at90 = usageThresholdsToNotify({ percent: 90, latched: [] });
    const afterDropTo50 = usageThresholdsToNotify({ percent: 50, latched: at90 });
    const reCrossedTo90 = usageThresholdsToNotify({ percent: 90, latched: at90 });

    expect([at90, afterDropTo50, reCrossedTo90]).toEqual([[80], [], []]);
  });

  it("notifies again once the latch belongs to a new period", () => {
    // The caller passes the latches stored for the counter's own period key, so
    // a new period starts from an empty latch and re-crosses 80 % once.
    expect(usageThresholdsToNotify({ percent: 90, latched: [] })).toEqual([80]);
  });
});

describe("RETENTION_STEPS and nextEraseStep", () => {
  it("declares the ordered erasure sequence of contract §10.2", () => {
    expect(RETENTION_STEPS).toEqual([
      "storage",
      "imageFaces",
      "faceMatches",
      "eventImages",
      "mediaAssets",
      "selfies",
      "profiles",
    ]);
  });

  it.each([
    { case: "no marker at all", marker: undefined, expected: "storage" },
    { case: "a null marker", marker: null, expected: "storage" },
    { case: "a marker without a step", marker: {}, expected: "storage" },
    { case: "a marker with a null step", marker: { step: null }, expected: "storage" },
    { case: "storage done", marker: { step: "storage" }, expected: "imageFaces" },
    { case: "imageFaces done", marker: { step: "imageFaces" }, expected: "faceMatches" },
    { case: "faceMatches done", marker: { step: "faceMatches" }, expected: "eventImages" },
    { case: "eventImages done", marker: { step: "eventImages" }, expected: "mediaAssets" },
    { case: "mediaAssets done", marker: { step: "mediaAssets" }, expected: "selfies" },
    { case: "selfies done", marker: { step: "profiles" }, expected: null },
    { case: "the complete marker", marker: { step: "done" }, expected: null },
  ])("answers $expected for $case", ({ marker, expected }) => {
    expect(nextEraseStep(marker)).toBe(expected);
  });

  it("restarts from the first step on an unrecognised marker", () => {
    expect(nextEraseStep({ step: "not-a-step" })).toBe("storage");
  });
});

describe("verificationNudgePoint", () => {
  const CREATED = new Date("2026-11-01T00:00:00.000Z");

  it.each([
    {
      case: "1 ms before T+24h",
      nudgesSent: 0,
      now: new Date(CREATED.getTime() + DAY_MS - 1),
      expected: null,
    },
    {
      case: "exactly T+24h",
      nudgesSent: 0,
      now: new Date(CREATED.getTime() + DAY_MS),
      expected: "t+24h",
    },
    {
      case: "the run after the first nudge, still before T+72h",
      nudgesSent: 1,
      now: new Date(CREATED.getTime() + DAY_MS + HOUR_MS),
      expected: null,
    },
    {
      case: "1 ms before T+72h",
      nudgesSent: 1,
      now: new Date(CREATED.getTime() + 3 * DAY_MS - 1),
      expected: null,
    },
    {
      case: "exactly T+72h",
      nudgesSent: 1,
      now: new Date(CREATED.getTime() + 3 * DAY_MS),
      expected: "t+72h",
    },
    {
      case: "a week later with one nudge sent",
      nudgesSent: 1,
      now: new Date(CREATED.getTime() + 7 * DAY_MS),
      expected: "t+72h",
    },
  ])("answers $expected for $case", ({ nudgesSent, now, expected }) => {
    expect(verificationNudgePoint({ createdAt: CREATED, completed: false, nudgesSent, now })).toBe(
      expected
    );
  });

  it("stops after two nudges, however old the account is", () => {
    expect(
      verificationNudgePoint({
        createdAt: CREATED,
        completed: false,
        nudgesSent: 2,
        now: new Date(CREATED.getTime() + 30 * DAY_MS),
      })
    ).toBeNull();
  });

  it("stops permanently once the account is complete", () => {
    expect(
      verificationNudgePoint({
        createdAt: CREATED,
        completed: true,
        nudgesSent: 0,
        now: new Date(CREATED.getTime() + 3 * DAY_MS),
      })
    ).toBeNull();
  });
});

describe("incrementalMatchRunKey", () => {
  const EVENT = "6702abc0000000000000e7e7";
  const PROFILE = "6702abc0000000000000a1a1";
  const SELFIE = "6702abc0000000000000c0c0";
  const RUN_AT = new Date("2026-11-17T09:10:00.000Z");

  it("is a second, distinct delivery identity for an already-announced selfie", () => {
    const runKey = incrementalMatchRunKey({
      eventId: EVENT,
      profileId: PROFILE,
      selfieId: SELFIE,
      runAt: RUN_AT,
    });

    expect(runKey).not.toBe(matchesNewDedupeKey(EVENT, PROFILE, SELFIE));
    expect(runKey.startsWith(`${matchesNewDedupeKey(EVENT, PROFILE, SELFIE)}:`)).toBe(true);
  });

  it("discriminates two runs for the same selfie", () => {
    const first = incrementalMatchRunKey({
      eventId: EVENT,
      profileId: PROFILE,
      selfieId: SELFIE,
      runAt: RUN_AT,
    });
    const second = incrementalMatchRunKey({
      eventId: EVENT,
      profileId: PROFILE,
      selfieId: SELFIE,
      runAt: new Date(RUN_AT.getTime() + 2 * HOUR_MS),
    });

    expect(first).not.toBe(second);
  });

  it("names the run instant it was minted for", () => {
    expect(
      incrementalMatchRunKey({
        eventId: EVENT,
        profileId: PROFILE,
        selfieId: SELFIE,
        runAt: RUN_AT,
      })
    ).toContain(RUN_AT.toISOString());
  });
});
