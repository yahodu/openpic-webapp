import type { Db, Document, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { weakETag } from "@/server/http/etag";
import type { NotificationSeverity } from "@/server/notifications/notification-types";
import { platformRepo } from "@/server/repos";

/**
 * The unread-count hot path's query pieces and pre-aggregate (OP-97, contract
 * §7.1/§7.2; design §19.4, §21, §22).
 *
 * The bell polls this path on the `platformSettings.notifications` cadence, so
 * three things must be cheap and cacheable:
 *
 *   - {@link buildUnreadCountFilter} is the exact predicate the count runs
 *     against — `{ userId, readAt: null, expireAt: { $gt: now } }`. `readAt:
 *     null` is what makes the **partial** index `idx_user_unread`
 *     (`{userId:1, createdAt:-1}` where `readAt: null`) applicable, and
 *     `expireAt` excludes rows the ~60 s TTL monitor has not swept yet.
 *   - {@link highestSeverity} lets the bell render a red vs. a grey dot without
 *     fetching the list.
 *   - {@link composeUnreadEtag} builds the weak `ETag` the client revalidates
 *     with, so an unchanged badge is a bodyless `304`.
 *
 * {@link summarizeUnread} is the shared read the unread-count route, the feed
 * `summary` and `read-all`'s post-mutation count all use, so the three surfaces
 * can never disagree about "how many unread do I have".
 */

/** The severity ranking, most severe first — `critical > important > informational`. */
const SEVERITY_ORDER: readonly NotificationSeverity[] = ["critical", "important", "informational"];

/** True when `value` is one of the three declared severities. */
function isSeverity(value: string): value is NotificationSeverity {
  return (SEVERITY_ORDER as readonly string[]).includes(value);
}

/**
 * The highest severity among `severities`, or `null` when nothing is unread.
 *
 * Unknown values are ignored (a new severity the client does not know yet must
 * not out-rank a known one); an empty set — or only unknown values — is `null`.
 *
 * @param severities - The severities of the rows being summarised.
 * @returns The ranking winner, or `null`.
 */
export function highestSeverity(severities: readonly string[]): NotificationSeverity | null {
  let best: NotificationSeverity | null = null;
  for (const severity of severities) {
    if (!isSeverity(severity)) {
      continue;
    }
    if (best === null || SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(best)) {
      best = severity;
    }
  }
  return best;
}

/** The inputs {@link composeUnreadEtag} folds into the conditional-request token. */
export interface ComposeUnreadEtagInput {
  /** The caller's unread count. */
  readonly unreadCount: number;
  /** The highest severity among the counted rows, or `null`. */
  readonly highestSeverity: string | null;
  /** The greatest `updatedAt` (whole seconds) among the counted rows; `0` when none. */
  readonly epochSeconds: number;
}

/**
 * Compose the weak `ETag` for the polled badge.
 *
 * The token is `` `${unreadCount}-${highestSeverity ?? "none"}-${epochSeconds}` ``
 * (contract §7.2's `W/"3-important-1790086920"` shape). The epoch is the
 * greatest `updatedAt` among the counted rows — so any mutation of the unread
 * set changes the token without a separate version counter — and `0` when
 * nothing is counted.
 *
 * @param input - The count, severity and version instant.
 * @returns The weak entity tag.
 */
export function composeUnreadEtag(input: ComposeUnreadEtagInput): string {
  return weakETag(
    `${String(input.unreadCount)}-${input.highestSeverity ?? "none"}-${String(input.epochSeconds)}`
  );
}

/** The inputs {@link buildUnreadCountFilter} turns into the count predicate. */
export interface UnreadCountFilterInput {
  /** The caller. */
  readonly userId: ObjectId;
  /** The instant TTL-expired rows are measured against. */
  readonly now: Date;
}

/**
 * The TTL predicate every live-notification read shares: a row is live only
 * while its `expireAt` is still in the future.
 *
 * The feed list, its `summary` and `GET /unread-count` all bind their reads by
 * this one builder, so the panel and the bell can never disagree about a row
 * the ~60 s TTL monitor has not swept yet (F3, OP-97).
 *
 * @param now - The instant TTL-expired rows are measured against.
 * @returns `{ expireAt: { $gt: now } }`.
 */
export function buildLiveNotificationFilter(now: Date): Document {
  return { expireAt: { $gt: now } };
}

/**
 * The exact indexed predicate the unread count runs.
 *
 * @param input - The caller and the current instant.
 * @returns `{ userId, readAt: null, expireAt: { $gt: now } }`.
 */
export function buildUnreadCountFilter(input: UnreadCountFilterInput): Document {
  return {
    userId: input.userId,
    readAt: null,
    ...buildLiveNotificationFilter(input.now),
  };
}

/** The aggregated unread state of one caller (contract §7.2). */
export interface UnreadSummary {
  /** The caller's total unread count. */
  readonly unreadCount: number;
  /** The non-zero per-category breakdown. */
  readonly byCategory: Record<string, number>;
  /** The highest severity among the unread rows, or `null` when nothing is unread. */
  readonly highestSeverity: NotificationSeverity | null;
  /** The greatest `updatedAt` (whole seconds) among the unread rows; `0` when none. */
  readonly epochSeconds: number;
}

/** The inputs {@link summarizeUnread} reads. */
export interface SummarizeUnreadInput {
  /** The database handle; the caller passes the shared client's. */
  readonly db: Db;
  /** The caller. */
  readonly userId: ObjectId;
  /** The instant TTL-expired rows are measured against. */
  readonly now: Date;
  /** The `typeKey`s the read path excludes (OTP defence in depth). */
  readonly excludeTypeKeys: ReadonlySet<string>;
  /** Denormalise a `typeKey` into its contract category. */
  readonly categoryOf: (typeKey: string) => string;
}

/** One `$group` bucket of the unread aggregation. */
interface UnreadGroup {
  readonly _id?: unknown;
  readonly count?: unknown;
  readonly severities?: unknown;
  readonly latestUpdatedAt?: unknown;
}

/**
 * Summarise the caller's unread state in one aggregation.
 *
 * The read is built on {@link buildUnreadCountFilter} — so it is exactly the
 * partial-index-supported predicate — with the excluded (`auth.otp.*` and other
 * `in_app:false`) keys filtered out, then grouped by `typeKey` (the stored row
 * does not carry `category`; it is denormalised in code).
 *
 * @param input - The database, caller, instant, exclusion set and category map.
 * @returns The count, non-zero per-category breakdown, highest severity and epoch.
 */
export async function summarizeUnread(input: SummarizeUnreadInput): Promise<UnreadSummary> {
  const filter: Document = {
    ...buildUnreadCountFilter({ userId: input.userId, now: input.now }),
    typeKey: { $nin: [...input.excludeTypeKeys] },
  };

  const groups = (await platformRepo(input.db)
    .collection(COLLECTIONS.notifications)
    .aggregate([
      { $match: filter },
      {
        $group: {
          _id: "$typeKey",
          count: { $sum: 1 },
          severities: { $addToSet: "$severity" },
          latestUpdatedAt: { $max: "$updatedAt" },
        },
      },
    ])
    .toArray()) as unknown as readonly UnreadGroup[];

  const byCategory: Record<string, number> = {};
  const severities: string[] = [];
  let unreadCount = 0;
  let epochMillis = 0;

  for (const group of groups) {
    const count = typeof group.count === "number" ? group.count : 0;
    const category = input.categoryOf(String(group._id));
    unreadCount += count;
    byCategory[category] = (byCategory[category] ?? 0) + count;

    if (Array.isArray(group.severities)) {
      for (const severity of group.severities) {
        if (typeof severity === "string") severities.push(severity);
      }
    }

    if (group.latestUpdatedAt instanceof Date) {
      epochMillis = Math.max(epochMillis, group.latestUpdatedAt.getTime());
    }
  }

  return {
    unreadCount,
    byCategory,
    highestSeverity: highestSeverity(severities),
    epochSeconds: Math.floor(epochMillis / 1000),
  };
}
