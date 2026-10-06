/**
 * Digest bucket flush (OP-96, design §6/§19.6, contract §10.2
 * `notification-digest-flush`, ADR-0100).
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
 * recipient per local day**, shared across digest types (ADR-0100 A4): the
 * count is the recipient's `flushed` buckets since local midnight in
 * `notificationPreferences.quietHours.timeZone` (UTC fallback, ADR-0100 A3). A
 * due bucket beyond the cap is **deferred**, not dropped — it stays `open` and
 * is not counted as `hasMore`.
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

/** The input to {@link computeDigestFlushAt} (ADR-0100 module contract). */
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
  };
}

/** The recipient's configured quiet-hours time zone, or UTC (ADR-0100 A3). */
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

/** The instant local midnight begins on `instant`'s civil day (ADR-0100 A3). */
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

/** Count the recipient's digest emails sent since local midnight (ADR-0100 A4). */
async function countFlushedToday(db: Db, userId: ObjectIdValue, now: Date): Promise<number> {
  const timeZone = await recipientTimeZone(db, userId);
  const since = startOfLocalDay(now, timeZone);
  return platformRepo(db)
    .collection(COLLECTIONS.notificationDigests)
    .countDocuments({ userId, status: "flushed", flushedAt: { $gte: since } });
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

/** The outcome of flushing one bucket. */
type FlushOne = "sent" | "error";

/** Flush one due bucket: render, send, write the ledger row, mark the bucket. */
async function flushOneBucket(
  db: Db,
  bucket: DigestBucket,
  now: Date,
  transport: MessageTransport,
  clock: Clock
): Promise<FlushOne> {
  const channel = bucket.channel as ResolvedChannel;
  const destination = await resolveDestination(db, bucket.userId, channel);
  if (destination === null) return "error";

  const { subject, body } = await renderSummary(db, bucket);
  const message = buildRedeliveryMessage(
    { userId: bucket.userId, channel, subject, body },
    destination
  );
  if (message === null) return "error";

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
    return "error";
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
 * A bucket beyond the recipient's daily cap is left `open` (deferred) and is
 * not counted as `hasMore`; `hasMore` is true only when a due, within-cap
 * bucket was left unprocessed because the limit was reached (ADR-0100 A1).
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

  const raw: unknown = await platformRepo(db)
    .collection(COLLECTIONS.notificationDigests)
    .find({ status: "open", flushAt: { $lte: now } })
    .sort({ flushAt: 1 })
    .toArray();
  const due = Array.isArray(raw)
    ? raw.map(asBucket).filter((bucket): bucket is DigestBucket => bucket !== null)
    : [];

  let scanned = 0;
  let affected = 0;
  let skipped = 0;
  let errors = 0;
  let hasMore = false;
  const sentByUser = new Map<string, number>();

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
      await platformRepo(db)
        .collection(COLLECTIONS.notificationDigests)
        .updateOne(
          { _id: bucket._id, status: "open" },
          { $set: { status: "flushed", flushedAt: now } }
        );
    } else {
      errors += 1;
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
