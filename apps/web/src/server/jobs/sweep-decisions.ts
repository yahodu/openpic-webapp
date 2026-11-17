/**
 * The pure decisions of the OP-136 sweeps (contract §10.2, ADR-0849 §1).
 *
 * Each sweep is "find the rows whose instant has arrived, do one conditional
 * write". The instant arithmetic and the latches are the parts a reviewer
 * cannot read off a query, so they live here: every input carries its own
 * instant and nothing in this module reads a clock.
 */

/** The ordered erasure sequence of contract §10.2 `retention-purge`. */
export const RETENTION_STEPS = [
  "storage",
  "imageFaces",
  "faceMatches",
  "eventImages",
  "mediaAssets",
  "selfies",
  "profiles",
] as const;

/** One step of {@link RETENTION_STEPS}. */
export type RetentionStep = (typeof RETENTION_STEPS)[number];

/** The `purge.step` value that marks a finished erase. */
export const ERASE_DONE = "done";

/** A schedule point of the upload window. */
export type UploadWindowPoint = "t-72h" | "t-24h" | "closed";

/** A schedule point of a retention warning; the two audiences never share one. */
export type RetentionWarningPoint = "t-14d" | "t-7d" | "t-3d" | "t-1d";

/** A rung of the verification-nudge ladder. */
export type VerificationNudgePoint = "t+24h" | "t+72h";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The organizer's warning days before the retention deadline. */
const ORGANIZER_WARNING_DAYS: readonly (readonly [RetentionWarningPoint, number])[] = [
  ["t-14d", 14],
  ["t-3d", 3],
];

/** The attendee's warning days before the retention deadline. */
const ATTENDEE_WARNING_DAYS: readonly (readonly [RetentionWarningPoint, number])[] = [
  ["t-7d", 7],
  ["t-1d", 1],
];

/** The usage thresholds a tenant is warned at, ascending. */
const USAGE_THRESHOLDS: readonly number[] = [80, 95, 100];

/** The nudge ladder: the rung, and its offset from the account's creation. */
const NUDGE_RUNGS: readonly (readonly [VerificationNudgePoint, number])[] = [
  ["t+24h", 24 * HOUR_MS],
  ["t+72h", 72 * HOUR_MS],
];

/**
 * Whether `now` falls inside a schedule point's fire window.
 *
 * A point at `instant` is due while `instant <= now < instant + intervalMs`, so
 * the exact boundary fires exactly once and one interval later is silent.
 *
 * @param instant - The point's own instant.
 * @param now - The instant the run is evaluated at.
 * @param intervalMs - The job's own cadence.
 * @returns `true` while the point is due.
 */
function withinRunWindow(instant: number, now: number, intervalMs: number): boolean {
  return now >= instant && now < instant + intervalMs;
}

/**
 * Resolve the upload-window point due at `now`.
 *
 * @param input - The window deadline (`null` when unlimited) and the instant.
 * @returns The due point, `"closed"` once the deadline has passed, else `null`.
 */
export function uploadWindowPoint(input: {
  readonly uploadWindowEndsAt: Date | null;
  readonly now: Date;
}): UploadWindowPoint | null {
  if (input.uploadWindowEndsAt === null) {
    return null;
  }
  const now = input.now.getTime();
  const endsAt = input.uploadWindowEndsAt.getTime();
  if (now >= endsAt) {
    return "closed";
  }
  if (withinRunWindow(endsAt - 72 * HOUR_MS, now, HOUR_MS)) {
    return "t-72h";
  }
  if (withinRunWindow(endsAt - 24 * HOUR_MS, now, HOUR_MS)) {
    return "t-24h";
  }
  return null;
}

/**
 * Resolve the retention warning due at `now` for one audience.
 *
 * The organizer is warned at T-14d and T-3d, the attendee at T-7d and T-1d, so
 * the two audiences' points stay disjoint.
 *
 * @param input - The retention deadline (`null` when unlimited), the instant and
 *   the audience.
 * @returns The due point, or `null` when no point of that audience is due.
 */
export function retentionWarningPoint(input: {
  readonly retentionExpiresAt: Date | null;
  readonly now: Date;
  readonly audience: "organizer" | "attendee";
}): RetentionWarningPoint | null {
  if (input.retentionExpiresAt === null) {
    return null;
  }
  const now = input.now.getTime();
  const expiresAt = input.retentionExpiresAt.getTime();
  const points = input.audience === "organizer" ? ORGANIZER_WARNING_DAYS : ATTENDEE_WARNING_DAYS;
  for (const [point, days] of points) {
    if (withinRunWindow(expiresAt - days * DAY_MS, now, DAY_MS)) {
      return point;
    }
  }
  return null;
}

/**
 * Resolve the status an event's own clock implies, or `null` to leave it alone.
 *
 * Only `published` and `live` are rewritten: a draft, an archived event and an
 * event whose erase is scheduled are never touched.
 *
 * @param input - The stored status, the two instants and the run instant.
 * @returns `"live"` at `startAt`, `"ended"` at `endAt`, else `null`.
 */
export function resolveEventStatus(input: {
  readonly status: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly now: Date;
}): "live" | "ended" | null {
  const now = input.now.getTime();
  if (now >= input.endAt.getTime()) {
    return input.status === "published" || input.status === "live" ? "ended" : null;
  }
  if (now >= input.startAt.getTime() && input.status === "published") {
    return "live";
  }
  return null;
}

/**
 * The thresholds the counter's current value crosses and its latch does not hold.
 *
 * @param input - The usage as a percentage of the effective limit (`null` when
 *   unlimited) and the thresholds already latched for this period.
 * @returns The thresholds to notify, ascending.
 */
export function usageThresholdsToNotify(input: {
  readonly percent: number | null;
  readonly latched: readonly number[];
}): readonly number[] {
  const percent = input.percent;
  if (percent === null) {
    return [];
  }
  return USAGE_THRESHOLDS.filter(
    (threshold) => percent >= threshold && !input.latched.includes(threshold)
  );
}

/**
 * Resolve the step an interrupted erase resumes on.
 *
 * `step` is the last **completed** step, so the answer is the next one. The
 * sentinel {@link ERASE_DONE} answers `null`; an absent, `null` or unrecognised
 * marker restarts from the first step, which is the only safe answer for a
 * marker this build cannot read.
 *
 * @param marker - The stored `event.purge` document, if any.
 * @returns The next step to run, or `null` when the erase is complete.
 */
export function nextEraseStep(
  marker: { readonly step?: string | null } | null | undefined
): RetentionStep | null {
  const step = marker?.step ?? null;
  if (step === ERASE_DONE) {
    return null;
  }
  const index = step === null ? -1 : (RETENTION_STEPS as readonly string[]).indexOf(step);
  return RETENTION_STEPS[index + 1] ?? null;
}

/**
 * Resolve the nudge rung due at `now`.
 *
 * The ladder is walked by count, not by window: rung `n` is due once its offset
 * has passed, so a run that drifts is still the right rung. The cap of two and
 * a completed account are terminal.
 *
 * @param input - The account's creation instant, its completion state, the
 *   nudges already sent and the run instant.
 * @returns The due rung, or `null` when nothing is due.
 */
export function verificationNudgePoint(input: {
  readonly createdAt: Date;
  readonly completed: boolean;
  readonly nudgesSent: number;
  readonly now: Date;
}): VerificationNudgePoint | null {
  if (input.completed || input.nudgesSent >= NUDGE_RUNGS.length) {
    return null;
  }
  const rung = NUDGE_RUNGS[input.nudgesSent];
  if (rung === undefined) {
    return null;
  }
  const [point, offset] = rung;
  return input.now.getTime() >= input.createdAt.getTime() + offset ? point : null;
}
