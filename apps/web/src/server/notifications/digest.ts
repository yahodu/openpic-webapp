/**
 * Digest bucket flush (OP-96, design §6/§19.6, contract §10.2
 * `notification-digest-flush`, ADR-0120).
 *
 * A `throttle.strategy: "digest"` type does not send on arrival: the fan-out
 * accumulates each occurrence into one open `notificationDigests` bucket keyed
 * by `{ userId, bucketKey, status: "open" }`. This module owns the two pure
 * scheduling rules — {@link computeDigestFlushAt} (push the flush forward to
 * `lastItemAt + quietMinutes`, but never past `firstItemAt + hardFlushHours`)
 * and {@link withinDigestDailyCap} (the per-recipient, per-local-day email
 * cap) — and {@link flushDueDigests}, the bounded job that renders one summary
 * per due bucket, sends it and marks the bucket `flushed`.
 *
 * The daily cap (`maxDigestEmailsPerDay`, default 3) is enforced **per
 * recipient per local day**, shared across digest types (ADR-0120 A4): the
 * count is the recipient's **delivered** flushes since local midnight in
 * `notificationPreferences.quietHours.timeZone` (UTC fallback, ADR-0120 A3) —
 * a flush whose send failed never reached the recipient, so it does not consume
 * the allowance (F1c, ADR-0134). A due bucket beyond the cap is **deferred**,
 * not dropped — it stays `open` and is not counted as `hasMore`.
 *
 * A bucket is closed only when the recorded failure has an owner (F1b,
 * ADR-0134): a **retryable** transport failure is redelivered by the ledger row,
 * while a **non-retryable** one leaves the bucket `open` for a later flush. The
 * re-attempts of a permanent (unrecoverable) failure are bounded (F1b-r2,
 * ADR-0137): once the bucket's unrecoverable failure count reaches
 * `pipeline.maxAttempts` it is closed terminally (`flushOutcome: "failed"`), so
 * the flush cron stops selecting it instead of retrying a "never retry" failure
 * forever. The same bound covers the **unrecorded** failure (F1, ADR-0141): a
 * bucket whose destination never resolves (`failed_unrecorded`) is refetched and
 * re-rendered on every tick with no ledger row to own a retry, so it shares the
 * one unrecoverable-failure counter and ceiling instead of looping to TTL.
 */
import type { Db, ObjectId as ObjectIdValue } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { getAppEnv } from "@/server/config/env";
import type { CronRunOutcome } from "@/server/jobs/cron-job";
import { getLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";
import { addDays } from "@/server/runtime/time";
import { getPlatformSettings } from "@/server/settings/platform-settings";

import type { MessageTransport } from "./message-transport";
import { notificationTemplateSchema, type NotificationTemplate } from "./notification-templates";
import { renderTemplate, type RenderVars } from "./render-template";
import type { ResolvedChannel } from "./resolve-channel";
import { buildRedeliveryMessage, resolveDestination, sendRedelivery } from "./dispatch-redelivery";

/** The single locale shipped in v1. */
const FALLBACK_LOCALE = "en-IN";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The input to {@link computeDigestFlushAt} (ADR-0120 module contract). */
export interface DigestFlushAtInput {
  /** The bucket's creation instant. */
  readonly firstItemAt: Date;
  /** The most recent arrival instant. */
  readonly lastItemAt: Date;
  /** `platformSettings.notifications.digestQuietMinutes`. */
  readonly quietMinutes: number;
  /** `platformSettings.notifications.digestHardFlushHours`. */
  readonly hardFlushHours: number;
}

/** Options accepted by {@link flushDueDigests}. */
export interface DigestFlushOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock; defaults to the system clock. */
  readonly clock?: Clock;
  /** The outbound transport the rendered summaries are handed to. */
  readonly transport: MessageTransport;
  /** Maximum buckets flushed per run; defaults to 1000. */
  readonly limit?: number;
}

/** A stored digest bucket (schema §19.6). */
interface DigestBucket {
  readonly _id: ObjectIdValue;
  readonly userId: ObjectIdValue;
  readonly typeKey: string;
  readonly bucketKey: string;
  readonly channel: string;
  readonly channelGroup: string;
  readonly itemCount: number;
  readonly sampleItems: readonly unknown[];
  readonly firstItemAt: Date;
  readonly lastItemAt: Date;
  readonly flushAt: Date;
  readonly status: string;
  /**
   * How many times this bucket's flush has failed **unrecoverably** (schema
   * §19.6) — a **non-retryable** transport failure, or an **unrecorded** failure
   * (no ledger row owns a retry). Once it reaches
   * `platformSettings.pipeline.maxAttempts` the bucket is closed terminally
   * (F1b-r2, ADR-0137; extended to `failed_unrecorded` by F1, ADR-0141).
   */
  readonly nonRetryableFailures?: number;
}

/** The scheduling half of the digest contract (design §19.6). */
export function computeDigestFlushAt(input: DigestFlushAtInput): Date {
  const pushForward = input.lastItemAt.getTime() + input.quietMinutes * MINUTE_MS;
  const hardCap = input.firstItemAt.getTime() + input.hardFlushHours * HOUR_MS;
  return new Date(Math.min(pushForward, hardCap));
}

/** True while the recipient still has daily digest allowance (U2). */
export function withinDigestDailyCap(sentToday: number, maxPerDay: number): boolean {
  return maxPerDay > 0 && sentToday < maxPerDay;
}

/** True for a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unknown stored value to a digest bucket. */
function asBucket(value: unknown): DigestBucket | null {
  if (!isRecord(value)) return null;
  const {
    _id,
    userId,
    typeKey,
    bucketKey,
    channel,
    channelGroup,
    itemCount,
    sampleItems,
    firstItemAt,
    lastItemAt,
    flushAt,
    status,
    nonRetryableFailures,
  } = value;
  if (
    _id === undefined ||
    userId === undefined ||
    typeof typeKey !== "string" ||
    typeof bucketKey !== "string" ||
    typeof channel !== "string" ||
    typeof channelGroup !== "string" ||
    typeof itemCount !== "number" ||
    !Array.isArray(sampleItems) ||
    !(firstItemAt instanceof Date) ||
    !(lastItemAt instanceof Date) ||
    !(flushAt instanceof Date) ||
    typeof status !== "string"
  ) {
    return null;
  }
  return {
    _id: _id as ObjectIdValue,
    userId: userId as ObjectIdValue,
    typeKey,
    bucketKey,
    channel,
    channelGroup,
    itemCount,
    sampleItems,
    firstItemAt,
    lastItemAt,
    flushAt,
    status,
    ...(typeof nonRetryableFailures === "number" ? { nonRetryableFailures } : {}),
  };
}

/** The recipient's configured quiet-hours time zone, or UTC (ADR-0120 A3). */
async function recipientTimeZone(db: Db, userId: ObjectIdValue): Promise<string> {
  const raw: unknown = await platformRepo(db)
    .collection(COLLECTIONS.notificationPreferences)
    .findOne({ userId });
  if (!isRecord(raw) || !isRecord(raw.quietHours)) return "UTC";
  const timeZone = raw.quietHours.timeZone;
  return typeof timeZone === "string" ? timeZone : "UTC";
}

/** The wall-clock fields of an instant in `timeZone`, or `null` for a bad zone. */
function zonedParts(
  instant: Date,
  timeZone: string
): { year: number; month: number; day: number; offsetMs: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    return null;
  }

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const localWallClockAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    value("hour"),
    value("minute"),
    value("second")
  );

  return { year, month, day, offsetMs: localWallClockAsUtc - instant.getTime() };
}

/** The instant local midnight begins on `instant`'s civil day (ADR-0120 A3). */
function startOfLocalDay(instant: Date, timeZone: string): Date {
  const parts = zonedParts(instant, timeZone);
  if (parts === null) {
    return new Date(
      Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate())
    );
  }
  const midnightWallClock = Date.UTC(parts.year, parts.month - 1, parts.day);
  return new Date(midnightWallClock - parts.offsetMs);
}

/**
 * Count the recipient's **delivered** digest emails since local midnight
 * (ADR-0120 A4, amended by ADR-0134).
 *
 * Only a `flushOutcome: "sent"` flush counts: a summary whose transport send
 * failed (retryably or not) never reached the recipient, so it must not burn the
 * day's `maxDigestEmailsPerDay` allowance (F1c, ADR-0134).
 */
async function countFlushedToday(db: Db, userId: ObjectIdValue, now: Date): Promise<number> {
  const timeZone = await recipientTimeZone(db, userId);
  const since = startOfLocalDay(now, timeZone);
  return platformRepo(db)
    .collection(COLLECTIONS.notificationDigests)
    .countDocuments({
      userId,
      status: "flushed",
      flushOutcome: "sent",
      flushedAt: { $gte: since },
    });
}

/** Load the active email template for a digest type, when one exists. */
async function loadSummaryTemplate(
  db: Db,
  typeKey: string,
  group: string
): Promise<NotificationTemplate | null> {
  const raw: unknown = await platformRepo(db)
    .collection(COLLECTIONS.notificationTemplates)
    .findOne({ typeKey, channel: group, active: true, locale: FALLBACK_LOCALE });
  if (raw === null) return null;
  const parsed = notificationTemplateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Build the variables the summary template renders with (declared vars, else empty). */
function summaryVars(
  template: NotificationTemplate,
  typeKey: string,
  itemCount: number,
  sampleItems: readonly unknown[]
): RenderVars {
  const source: Record<string, string | number> = { typeKey, count: itemCount };
  const first = sampleItems[0];
  if (isRecord(first)) {
    for (const [key, value] of Object.entries(first)) {
      if (typeof value === "string" || typeof value === "number") source[key] = value;
    }
  }

  const vars: Record<string, string | number> = {};
  for (const declared of template.variables) {
    vars[declared] = source[declared] ?? "";
  }
  return vars;
}

/** Render the one summary a bucket flushes (design §6). */
async function renderSummary(
  db: Db,
  bucket: DigestBucket
): Promise<{ readonly subject: string; readonly body: string }> {
  const template = await loadSummaryTemplate(db, bucket.typeKey, bucket.channelGroup);
  if (template === null) {
    return {
      subject: `${bucket.typeKey} summary`,
      body: `You have ${String(bucket.itemCount)} new update(s).`,
    };
  }

  try {
    const rendered = renderTemplate(
      [template],
      summaryVars(template, bucket.typeKey, bucket.itemCount, bucket.sampleItems),
      FALLBACK_LOCALE
    );
    return {
      subject: rendered.subject,
      body: `${String(bucket.itemCount)} new update(s).\n\n${rendered.body}`,
    };
  } catch {
    return {
      subject: `${bucket.typeKey} summary`,
      body: `You have ${String(bucket.itemCount)} new update(s).`,
    };
  }
}

/**
 * The outcome of flushing one bucket:
 *
 * - `sent` — the transport accepted the summary.
 * - `failed_retryable` — the transport rejected the send retryably; the
 *   `failed` ledger row owns the redelivery (`lastError.retryable: true`),
 *   so the caller closes the bucket (F1, ADR-0130).
 * - `failed_terminal` — the transport rejected the send **non-retryably**; the
 *   ledger row is recorded but no cron will ever re-select it, so nothing owns
 *   the redelivery and the bucket must stay `open` (F1b, ADR-0134) — until the
 *   bounded non-retryable failure count reaches `pipeline.maxAttempts`, when the
 *   caller closes it terminally (F1b-r2, ADR-0137).
 * - `failed_unrecorded` — no ledger row at all (an unresolvable destination or
 *   an unbuildable message); nothing owns a retry, so the bucket stays `open`.
 */
type FlushOne = "sent" | "failed_retryable" | "failed_terminal" | "failed_unrecorded";

/**
 * Flush one due bucket: render, send, write the ledger row, classify the
 * failure's owner.
 *
 * A transport failure is **durably recorded on the ledger row**. Whether that
 * row owns the redelivery decides what happens to the bucket: a **retryable**
 * failure is owned by `notification-dispatch-retry` (ADR-0127/ADR-0130), so the
 * caller closes the bucket; a **non-retryable** failure has no owner, so the
 * bucket stays `open` and a later flush re-attempts the summary (F1b, ADR-0134).
 * A failure with no ledger row (an unresolvable destination or an unbuildable
 * message) is `failed_unrecorded` — also left `open`.
 */
async function flushOneBucket(
  db: Db,
  bucket: DigestBucket,
  now: Date,
  transport: MessageTransport,
  clock: Clock
): Promise<FlushOne> {
  const channel = bucket.channel as ResolvedChannel;
  const destination = await resolveDestination(db, bucket.userId, channel);
  if (destination === null) return "failed_unrecorded";

  const { subject, body } = await renderSummary(db, bucket);
  const message = buildRedeliveryMessage(
    { userId: bucket.userId, channel, subject, body },
    destination
  );
  if (message === null) return "failed_unrecorded";

  const outcome = await sendRedelivery(transport, message);
  const settings = await getPlatformSettings({ db, clock });
  const expireAt = addDays(now, settings.retention.dispatchDays);

  if (!outcome.ok) {
    await platformRepo(db).collection(COLLECTIONS.dispatches).insertOne({
      userId: bucket.userId,
      tenantId: null,
      eventId: null,
      typeKey: bucket.typeKey,
      channelGroup: bucket.channelGroup,
      channel,
      status: "failed",
      skipReason: null,
      contactHash: null,
      templateVersion: null,
      dedupeKey: null,
      providerRef: null,
      attempts: 1,
      lastError: outcome.failure,
      subject,
      body,
      until: null,
      queuedAt: now,
      sentAt: null,
      deliveredAt: null,
      failedAt: now,
      notificationId: null,
      expireAt,
    });
    // The ledger row owns the redelivery only when the failure is retryable
    // (`notification-dispatch-retry` selects `lastError.retryable: true`). A
    // non-retryable failure has no owner, so the bucket must stay selectable.
    return outcome.failure.retryable ? "failed_retryable" : "failed_terminal";
  }

  await platformRepo(db)
    .collection(COLLECTIONS.dispatches)
    .insertOne({
      userId: bucket.userId,
      tenantId: null,
      eventId: null,
      typeKey: bucket.typeKey,
      channelGroup: bucket.channelGroup,
      channel,
      status: "sent",
      skipReason: null,
      contactHash: null,
      templateVersion: null,
      dedupeKey: null,
      providerRef: {
        provider: "transport",
        env: getAppEnv(),
        messageId: outcome.receipt.providerMessageId,
      },
      attempts: 1,
      lastError: null,
      subject,
      body,
      until: null,
      queuedAt: now,
      sentAt: now,
      deliveredAt: null,
      failedAt: null,
      notificationId: null,
      expireAt,
    });

  return "sent";
}

/**
 * Flush every due open digest bucket, bounded by `limit`.
 *
 * The read is bounded (F3, ADR-0130): one more bucket than the run will process
 * is fetched, so `hasMore` reports a remaining backlog without materialising it
 * — `hasMore` is true when more selectable (due, open) buckets exist beyond
 * `limit` (ADR-0120 A1, amended by ADR-0130). A bucket beyond the recipient's
 * daily cap is left `open` (deferred) and is **not** counted as `hasMore`.
 *
 * A transport failure is durably recorded on the ledger row, and the bucket is
 * marked `flushed` **only when that row owns the redelivery** — i.e. the failure
 * is retryable (F1, ADR-0130). A non-retryable failure has no owner, so the
 * bucket stays `open` and a later tick re-attempts the summary (F1b, ADR-0134) —
 * but only up to `pipeline.maxAttempts` times, after which it is closed
 * terminally (F1b-r2, ADR-0137). A closed bucket records whether the summary
 * actually went out (`flushOutcome: "sent" | "failed"`), and only a `"sent"`
 * flush consumes the recipient's daily allowance (F1c, ADR-0134).
 *
 * @param options - Database/clock/transport seams and the per-run limit.
 * @returns The §10.2 run outcome.
 */
export async function flushDueDigests(options: DigestFlushOptions): Promise<CronRunOutcome> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const limit = options.limit ?? 1000;
  const now = clock.now();

  const settings = await getPlatformSettings({ db, clock });
  const maxPerDay = settings.notifications.maxDigestEmailsPerDay;
  const maxAttempts = settings.pipeline.maxAttempts;

  const raw: unknown = await platformRepo(db)
    .collection(COLLECTIONS.notificationDigests)
    .find({ status: "open", flushAt: { $lte: now } })
    .sort({ flushAt: 1 })
    .limit(limit + 1)
    .toArray();
  const due = Array.isArray(raw)
    ? raw.map(asBucket).filter((bucket): bucket is DigestBucket => bucket !== null)
    : [];

  let scanned = 0;
  let affected = 0;
  let skipped = 0;
  let errors = 0;
  let hasMore = due.length > limit;
  const sentByUser = new Map<string, number>();

  /**
   * Mark a bucket closed so the flush cron never re-selects it (F1).
   *
   * `flushOutcome` records **why** it closed, distinctly from `status`
   * (F1c, ADR-0134): only a delivered summary consumes the recipient's daily
   * allowance, so {@link countFlushedToday} counts `"sent"` flushes alone.
   */
  const markFlushed = (bucket: DigestBucket, flushOutcome: "sent" | "failed"): Promise<unknown> =>
    platformRepo(db)
      .collection(COLLECTIONS.notificationDigests)
      .updateOne(
        { _id: bucket._id, status: "open" },
        { $set: { status: "flushed", flushOutcome, flushedAt: now } }
      );

  /**
   * Record one **unrecoverable** flush failure against the bucket and return the
   * resulting count (schema §19.6, F1b-r2, ADR-0137; extended to
   * `failed_unrecorded` by F1, ADR-0141).
   *
   * "Unrecoverable" covers both permanent-failure classes the flush cron must
   * not keep retrying: a **non-retryable** transport failure (whose ledger row
   * owns no redelivery) and an **unrecorded** failure (which writes no ledger
   * row at all). Sharing one counter and one ceiling means a bucket that
   * alternates between the two classes is still bounded, and the terminal close
   * is reached by whichever combination of failures accumulates to
   * `pipeline.maxAttempts`.
   *
   * The increment is a single atomic `$inc`, so concurrent flush workers can
   * never lose a failure recorded for the same bucket.
   */
  const recordUnrecoverableFailure = async (bucket: DigestBucket): Promise<number> => {
    const updated: unknown = await platformRepo(db)
      .collection(COLLECTIONS.notificationDigests)
      .findOneAndUpdate(
        { _id: bucket._id, status: "open" },
        { $inc: { nonRetryableFailures: 1 } },
        { returnDocument: "after" }
      );
    const count = isRecord(updated) ? updated.nonRetryableFailures : undefined;
    return typeof count === "number" ? count : (bucket.nonRetryableFailures ?? 0) + 1;
  };

  for (const bucket of due) {
    scanned += 1;

    const key = bucket.userId.toHexString();
    const sentToday = sentByUser.get(key) ?? (await countFlushedToday(db, bucket.userId, now));

    if (!withinDigestDailyCap(sentToday, maxPerDay)) {
      // Deferred: stays `open` for a later day, never dropped, not `hasMore`.
      skipped += 1;
      continue;
    }

    if (affected >= limit) {
      hasMore = true;
      break;
    }

    const result = await flushOneBucket(db, bucket, now, options.transport, clock);
    if (result === "sent") {
      affected += 1;
      sentByUser.set(key, sentToday + 1);
      await markFlushed(bucket, "sent");
    } else if (result === "failed_retryable") {
      // The failure is durably on the ledger row, which owns the redelivery
      // (ADR-0127/ADR-0130); close the bucket so the flush cron cannot re-send.
      // A summary that never went out does not consume the daily allowance
      // (F1c, ADR-0134), so `sentByUser` is deliberately left unchanged.
      errors += 1;
      await markFlushed(bucket, "failed");
    } else if (result === "failed_terminal") {
      // No owner took the redelivery on a non-retryable failure, so the bucket
      // stays `open` for a later attempt (F1b, ADR-0134) — but the retries are
      // **bounded** (F1b-r2, ADR-0137): once the non-retryable failure count
      // reaches `pipeline.maxAttempts` the bucket is closed terminally
      // (`status: "flushed"`, `flushOutcome: "failed"`) so the flush cron's
      // `status: "open"` read stops selecting it.
      errors += 1;
      const failures = await recordUnrecoverableFailure(bucket);
      if (failures >= maxAttempts) {
        await markFlushed(bucket, "failed");
      }
    } else {
      // No owner took the redelivery — a failure recorded nowhere at all (an
      // unresolvable destination or an unbuildable message). Nothing durably
      // owns a retry, so a later flush re-attempts the summary (F1b, ADR-0134)
      // — but those re-attempts are **bounded** (F1, ADR-0141): the failure is
      // counted against the same unrecoverable-failure ceiling as a
      // non-retryable transport failure, and once it reaches
      // `pipeline.maxAttempts` the bucket is closed terminally
      // (`status: "flushed"`, `flushOutcome: "failed"`) so the flush cron's
      // `status: "open"` read stops re-selecting and re-rendering it.
      errors += 1;
      const failures = await recordUnrecoverableFailure(bucket);
      if (failures >= maxAttempts) {
        await markFlushed(bucket, "failed");
      }
    }
  }

  getLogger().info("digest flush completed", {
    event: "notification.digest_flush",
    scanned,
    affected,
    skipped,
    errors,
    hasMore,
    limit,
  });

  return { scanned, affected, skipped, errors, hasMore };
}
