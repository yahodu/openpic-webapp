import { ObjectId } from "mongodb";
import { z } from "zod";

import type { NotificationCategory } from "@/server/notifications/notification-types";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";

/**
 * The in-app feed's window mapping, projection and response contract (OP-97,
 * contract §7.1; design §19.4, §21, §22).
 *
 * The feed exposes four filters whose only difference is the `createdAt` band
 * they read, projects stored rows to the exact §7.1 shape, and denormalises the
 * `category` the stored row does not carry from the compile-time catalogue (so
 * the read needs no extra database round-trip).
 *
 * Two invariants live here because they are cross-cutting:
 *
 *   - the **OTP exclusion set** (`@link EXCLUDED_FEED_TYPE_KEYS`) — `auth.otp.*`
 *     rows must never be listed or counted, even if one is stored directly
 *     (defence in depth, design §4 rule 6);
 *   - the **windowed projection** (`@link projectFeedItem`) — exactly the
 *     eighteen §7.1 fields; `_id`, `titleKey` and `expireAt` never reach the
 *     wire, and `title`/`body` are returned verbatim (never re-rendered).
 */

/** The four `filter` bands (contract §7.1). */
export type FeedFilter = "active" | "unread" | "all" | "archived";

/** The active band: the last 30 days (contract §7.1). */
export const FEED_ACTIVE_WINDOW_DAYS = 30;

/** The TTL horizon: nothing older than 90 days exists (schema §22). */
export const FEED_TTL_HORIZON_DAYS = 90;

/** The default page size (contract §7.1). */
export const FEED_DEFAULT_LIMIT = 20;

/** The page-size ceiling a larger `limit` is clamped to (contract §7.1). */
export const FEED_MAX_LIMIT = 50;

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** `windowDays` never reaches further back than this, whatever it is set to. */
function clampWindowDays(windowDays: number): number {
  return Math.min(windowDays, FEED_TTL_HORIZON_DAYS);
}

/** The `createdAt` band one `filter` reads. */
export interface FeedWindow {
  /** The inclusive lower bound of the band. */
  readonly from: Date;
  /** The exclusive upper bound, or `null` for an open band. */
  readonly to: Date | null;
}

/** The inputs {@link resolveFeedWindow} maps to a band. */
export interface ResolveFeedWindowInput {
  /** The `filter` query value (its default is `active`). */
  readonly filter: FeedFilter;
  /** The current instant. */
  readonly now: Date;
  /**
   * The `window` query value: a positive day count that narrows the lookback.
   * Capped at the 90-day TTL horizon, ignored for `archived` and for a
   * non-positive value.
   */
  readonly windowDays?: number | null;
}

/**
 * Map a `filter` (and an optional `window`) to the `createdAt` band to read.
 *
 * | `filter`   | `from`    | `to`      |
 * | ---------- | --------- | --------- |
 * | `active`   | `now−30d` | `null`    |
 * | `unread`   | `now−90d` | `null`    |
 * | `all`      | `now−90d` | `null`    |
 * | `archived` | `now−90d` | `now−30d` |
 *
 * A supplied positive `windowDays` replaces the filter-derived `from` with
 * `now − min(windowDays, 90) days` and leaves `to` untouched.
 *
 * @param input - The filter, the current instant and an optional lookback.
 * @returns The band's bounds.
 */
export function resolveFeedWindow(input: ResolveFeedWindowInput): FeedWindow {
  const { now, filter } = input;
  const horizonFrom = new Date(now.getTime() - FEED_TTL_HORIZON_DAYS * DAY_MS);

  if (filter === "archived") {
    // The 30–90 day band is fixed; `window` never narrows an archive view.
    return { from: horizonFrom, to: new Date(now.getTime() - FEED_ACTIVE_WINDOW_DAYS * DAY_MS) };
  }

  const filterFrom =
    filter === "active" ? new Date(now.getTime() - FEED_ACTIVE_WINDOW_DAYS * DAY_MS) : horizonFrom;

  const windowDays = input.windowDays;
  if (typeof windowDays === "number" && Number.isFinite(windowDays) && windowDays > 0) {
    return {
      from: new Date(now.getTime() - clampWindowDays(windowDays) * DAY_MS),
      to: null,
    };
  }

  return { from: filterFrom, to: null };
}

/** The `category` of every seeded `typeKey` (the stored feed row carries no category). */
const CATEGORY_BY_TYPE_KEY: ReadonlyMap<string, NotificationCategory> = new Map(
  SEED_NOTIFICATION_TYPES.map((type) => [type.typeKey, type.category])
);

/**
 * The `typeKey` prefix → category fallback for a `typeKey` outside the seed.
 *
 * The contract requires an unknown `typeKey` to render generically (rule 4), so
 * the projection must still name *a* category; the prefix of a v1-style key
 * (`auth.`, `billing.`, …) is the best available signal without a database read.
 */
const PREFIX_CATEGORY: readonly (readonly [string, NotificationCategory])[] = [
  ["auth", "authentication"],
  ["account", "account"],
  ["billing", "billing"],
  ["usage", "usage"],
  ["event", "event"],
  ["collab", "collaboration"],
  ["upload", "pipeline"],
  ["pipeline", "pipeline"],
  ["attendee", "matching"],
  ["legal", "compliance"],
  ["privacy", "compliance"],
  ["admin", "platform_ops"],
];

/** The fallback category when neither the catalogue nor the prefix names one. */
const FALLBACK_CATEGORY: NotificationCategory = "platform_ops";

/**
 * Denormalise a feed row's `category` from its `typeKey`.
 *
 * @param typeKey - The stored `typeKey`.
 * @returns The catalogue category, the prefix-derived category, or the fallback.
 */
export function feedCategoryFor(typeKey: string): NotificationCategory {
  const known = CATEGORY_BY_TYPE_KEY.get(typeKey);
  if (known !== undefined) {
    return known;
  }

  const prefix = typeKey.split(".")[0] ?? "";
  for (const [candidate, category] of PREFIX_CATEGORY) {
    if (candidate === prefix) {
      return category;
    }
  }
  return FALLBACK_CATEGORY;
}

/**
 * The `typeKey`s the feed must never list or count.
 *
 * Derived from the catalogue's `channelGroups.in_app.enabled === false` types
 * (design §4 rule 6/7, schema §19.1) rather than hard-coded, so a future type
 * that ships without an in-app channel is excluded by construction. Today this
 * covers both `auth.otp.*` keys — the OTP secrecy rule — plus the other types
 * that declare no in-app channel.
 */
export const EXCLUDED_FEED_TYPE_KEYS: ReadonlySet<string> = new Set(
  SEED_NOTIFICATION_TYPES.filter(
    (type) => type.channelGroups.find((group) => group.group === "in_app")?.enabled !== true
  ).map((type) => type.typeKey)
);

/**
 * The `typeKey`s whose catalogue category is one of `categories`.
 *
 * A `category` query value is not stored on the row, so the feed filters on the
 * `typeKey` set the category maps to. An unknown category yields an empty set
 * (the filter matches nothing).
 *
 * @param categories - The requested category values (repeatable).
 * @returns The matching `typeKey`s.
 */
export function feedTypeKeysForCategories(categories: readonly string[]): string[] {
  const wanted = new Set(categories);
  return SEED_NOTIFICATION_TYPES.filter((type) => wanted.has(type.category)).map(
    (type) => type.typeKey
  );
}

/** A stored `notifications` row as the read path sees it (schema §19.4). */
export interface StoredFeedRow {
  readonly _id: ObjectId;
  readonly typeKey: string;
  readonly severity?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly data?: unknown;
  readonly groupKey?: unknown;
  readonly groupCount?: unknown;
  readonly actionTarget?: unknown;
  readonly actions?: unknown;
  readonly actionResolvedVia?: unknown;
  readonly actionResolvedAt?: unknown;
  readonly readAt?: unknown;
  readonly eventId?: unknown;
  readonly tenantId?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

/** One projected §7.1 feed item. */
export interface FeedItem {
  readonly id: string;
  readonly typeKey: string;
  readonly category: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly groupKey: string | null;
  readonly groupCount: number;
  readonly actionTarget: Record<string, unknown> | null;
  readonly actions: readonly Record<string, unknown>[];
  readonly actionResolvedVia: string | null;
  readonly actionResolvedAt: string | null;
  readonly readAt: string | null;
  readonly eventId: string | null;
  readonly tenantId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The ISO-8601 rendering of a stored instant, or `null`. */
function isoOrNull(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/** The hex rendering of a stored id (ObjectId or already-hex string), or `null`. */
function idOrNull(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A plain object, defaulting to `{}` for anything else. */
function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** An array of plain objects, defaulting to `[]` for anything else. */
function recordsOrEmpty(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
      )
    : [];
}

/** The `severity` used when a stored row carries no usable value (never expected). */
const FALLBACK_SEVERITY = "informational";

/** The instant used when a stored row lacks a usable timestamp (never expected). */
const FALLBACK_ISO = new Date(0).toISOString();

/**
 * Project one stored feed row to the exact §7.1 shape.
 *
 * `title`/`body` are the stored, pre-rendered strings (verbatim, never
 * re-rendered); `category` is denormalised from the catalogue; `_id`, `titleKey`
 * and `expireAt` are dropped. The two unresolved-action audit fields are always
 * present and `null` when the row carries no resolution.
 *
 * @param row - The stored `notifications` document.
 * @returns The wire item.
 */
export function projectFeedItem(row: StoredFeedRow): FeedItem {
  const actionTarget = recordOrEmpty(row.actionTarget);
  const data = recordOrEmpty(row.data);

  return {
    id: row._id.toHexString(),
    typeKey: row.typeKey,
    category: feedCategoryFor(row.typeKey),
    severity:
      typeof row.severity === "string" && row.severity.length > 0
        ? row.severity
        : FALLBACK_SEVERITY,
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    data,
    groupKey: typeof row.groupKey === "string" ? row.groupKey : null,
    groupCount: typeof row.groupCount === "number" ? row.groupCount : 1,
    actionTarget: Object.keys(actionTarget).length > 0 ? actionTarget : null,
    actions: recordsOrEmpty(row.actions),
    actionResolvedVia: typeof row.actionResolvedVia === "string" ? row.actionResolvedVia : null,
    actionResolvedAt: isoOrNull(row.actionResolvedAt),
    readAt: isoOrNull(row.readAt),
    eventId: idOrNull(row.eventId),
    tenantId: typeof row.tenantId === "string" ? row.tenantId : null,
    createdAt: isoOrNull(row.createdAt) ?? FALLBACK_ISO,
    updatedAt: isoOrNull(row.updatedAt) ?? FALLBACK_ISO,
  };
}

/** One projected feed item, validated strictly on the way out. */
const feedItemSchema = z.object({
  id: z.string(),
  typeKey: z.string(),
  category: z.string(),
  severity: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  groupKey: z.string().nullable(),
  groupCount: z.number(),
  actionTarget: z.record(z.string(), z.unknown()).nullable(),
  actions: z.array(z.record(z.string(), z.unknown())),
  actionResolvedVia: z.string().nullable(),
  actionResolvedAt: z.string().nullable(),
  readAt: z.string().nullable(),
  eventId: z.string().nullable(),
  tenantId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * The `GET /api/v1/me/notifications` response body (contract §7.1).
 *
 * The pipeline validates the handler's result through this schema strictly, so
 * any extra key (a leaked `titleKey`, a raw `_id`) is a 500 rather than a leak.
 */
export const feedResponseSchema = z.object({
  data: z.array(feedItemSchema),
  page: z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    limit: z.number(),
  }),
  summary: z.object({
    unreadCount: z.number(),
    unreadByCategory: z.record(z.string(), z.number()),
  }),
});

/** The validated feed response. */
export type FeedResponse = z.infer<typeof feedResponseSchema>;
