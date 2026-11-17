import { describe, expect, it } from "vitest";

import {
  eventIndexingComplete,
  nextPollAfter,
  pollIntervalMs,
  type AttendeeStatus,
} from "@/server/attendee/poll-policy";

/**
 * Unit contract — the adaptive poll-interval policy table
 * (OP-133 U1; contract §6.4; ADR-0793 §1).
 *
 * **Why this exists.** §6.4 calls adaptive polling "server-driven": the client
 * must never decide when to poll again, because the same page has to be cheap
 * while a selfie is processing and cheap in a different way once the gallery is
 * settled. The policy is therefore a table on the server, and this spec is that
 * table. A client that polls a `processing` selfie every 60 s looks broken; a
 * client that polls a settled gallery every 2 s is a self-inflicted rate-limit.
 *
 * **Contract pinned here.**
 *
 * ```
 * pollIntervalMs({ status, indexingComplete }): 2000 | 15000 | 60000
 * nextPollAfter(now: Date, intervalMs: number): Date   // now + intervalMs, `now` untouched
 * ```
 *
 * The three values are the ones §6.4 documents, and they are the **only**
 * values the policy may return:
 *
 * | status                              | interval                                  |
 * | ----------------------------------- | ----------------------------------------- |
 * | `processing`                        | `2000` (whatever `indexingComplete` says) |
 * | `ready`/`no_match`, not complete    | `15000`                                   |
 * | `ready`/`no_match`, complete        | `60000`                                   |
 * | every other terminal/waiting status | `60000`                                   |
 *
 * The last row is the decision this record makes: `no_selfie`, `selfie_pending`,
 * `failed` and `withdrawn` cannot change on the server until the attendee acts,
 * so polling them faster only burns the `read.hot` budget.
 */

/** The three cadences of §6.4, by name, so a failure names the intent. */
const PROCESSING_MS = 2000;
const INDEXING_MS = 15000;
const SETTLED_MS = 60000;

/** Every status §6.4 defines, in the order the contract lists them. */
const STATUSES: readonly AttendeeStatus[] = [
  "no_selfie",
  "selfie_pending",
  "processing",
  "ready",
  "no_match",
  "failed",
  "withdrawn",
];

describe("the poll interval policy", () => {
  it.each<readonly [AttendeeStatus, boolean, number]>([
    ["processing", false, PROCESSING_MS],
    ["processing", true, PROCESSING_MS],
    ["ready", false, INDEXING_MS],
    ["ready", true, SETTLED_MS],
    ["no_match", false, INDEXING_MS],
    ["no_match", true, SETTLED_MS],
    ["selfie_pending", false, SETTLED_MS],
    ["selfie_pending", true, SETTLED_MS],
    ["no_selfie", false, SETTLED_MS],
    ["no_selfie", true, SETTLED_MS],
    ["failed", false, SETTLED_MS],
    ["failed", true, SETTLED_MS],
    ["withdrawn", false, SETTLED_MS],
    ["withdrawn", true, SETTLED_MS],
  ])("answers %s with indexingComplete=%s as %i ms", (status, indexingComplete, expected) => {
    expect(pollIntervalMs({ status, indexingComplete })).toBe(expected);
  });

  it("never answers an interval §6.4 does not document", () => {
    const answered = new Set<number>();
    for (const status of STATUSES) {
      answered.add(pollIntervalMs({ status, indexingComplete: false }));
      answered.add(pollIntervalMs({ status, indexingComplete: true }));
    }

    expect([...answered].sort((left, right) => left - right)).toEqual([
      PROCESSING_MS,
      INDEXING_MS,
      SETTLED_MS,
    ]);
  });

  it("polls a processing selfie at the fast cadence even when the event has finished indexing", () => {
    // The selfie's own pipeline is what the page is waiting for, so the event's
    // indexing state must not slow it down.
    expect(pollIntervalMs({ status: "processing", indexingComplete: true })).toBe(PROCESSING_MS);
  });
});

describe("nextPollAfter", () => {
  it("returns the instant the client may poll again", () => {
    const now = new Date("2026-11-13T10:00:00.000Z");

    expect(nextPollAfter(now, PROCESSING_MS)).toEqual(new Date("2026-11-13T10:00:02.000Z"));
  });

  it("adds the settled cadence without rounding to whole seconds", () => {
    const now = new Date("2026-11-13T10:00:00.500Z");

    expect(nextPollAfter(now, SETTLED_MS)).toEqual(new Date("2026-11-13T10:01:00.500Z"));
  });

  it("does not mutate the instant it was given", () => {
    const now = new Date("2026-11-13T10:00:00.000Z");
    const before = now.getTime();

    nextPollAfter(now, INDEXING_MS);

    expect(now.getTime()).toBe(before);
  });
});

/* ─────────── P5 — one drained predicate for both attendee readers ─────────── */

/**
 * The three `events.counters` fields indexing progress is read from (§15.1),
 * stated here as one object so a case can pass the event's own counters to the
 * predicate unchanged (ADR-0314 §Decision item 1).
 */
interface IndexingCounters {
  readonly imageCount: number;
  readonly processedImageCount: number;
  readonly failedImageCount: number;
}

/**
 * P5 of ADR-0314 — `eventIndexingComplete` counts the images that **failed**,
 * not only the ones that were processed.
 *
 * The flag is the event's own progress (ADR-0793 §10), and two shipped
 * readers already answer it that way: `GET /api/v1/p/events/{slug}`
 * (`processedImageCount + failedImageCount >= imageCount`) and
 * `derivePipelineStatus`. This predicate counted `processedImageCount` alone, so
 * an event whose remaining images were permanently failed never settled for the
 * attendee — `4 + 1 >= 5` is never `4 >= 5` — and `/me` kept
 * `pollIntervalMs: 15000` for the rest of the event's life. A permanently failed
 * image drains the event: `partial_failure`/`delayed` is a pipeline *state*, not
 * "still indexing" (ADR-0314 §Decision item 5, which supersedes the earlier
 * predicate arithmetic while keeping its intent).
 */
describe("eventIndexingComplete — the drained predicate (ADR-0314 §5)", () => {
  it.each<readonly [IndexingCounters, boolean]>([
    [{ imageCount: 5, processedImageCount: 4, failedImageCount: 1 }, true],
    [{ imageCount: 5, processedImageCount: 4, failedImageCount: 0 }, false],
    [{ imageCount: 5, processedImageCount: 5, failedImageCount: 0 }, true],
    [{ imageCount: 0, processedImageCount: 0, failedImageCount: 0 }, true],
  ])("answers %o with %s", (counters, expected) => {
    expect(eventIndexingComplete(counters)).toBe(expected);
  });

  it("drains an event whose only remaining image failed, so the gallery settles", () => {
    // The shipped failure: five images, four processed, one permanently failed.
    // The gallery is as complete as it will ever be, so the poll must settle.
    const counters: IndexingCounters = {
      imageCount: 5,
      processedImageCount: 4,
      failedImageCount: 1,
    };

    expect(eventIndexingComplete(counters)).toBe(true);
  });
});
