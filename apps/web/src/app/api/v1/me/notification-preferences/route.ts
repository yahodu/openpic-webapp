import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { listEnabledNotificationTypes } from "@/server/notifications/notification-types-read";
import {
  applyPreferencesPatch,
  DEFAULT_PREFERENCES,
  isValidClockTime,
  mergePreferences,
  type ChannelGroupName,
  type DigestPreference,
  type GroupPreferences,
  type PreferenceValue,
  type QuietHoursSettings,
  type StoredPreferences,
} from "@/server/notifications/preferences";
import { platformRepo } from "@/server/repos";

/**
 * `GET` / `PATCH /api/v1/me/notification-preferences` (contract §7.4; design
 * §19.1, §19.3; ADR-0220, ADR-0221).
 *
 * `GET` reads the caller's §19.3 `notificationPreferences` document and merges
 * it with the catalogue through `@/server/notifications/preferences`, so the
 * settings screen is one read: the sparse `global`/`byType`/`byEvent`/`digest`
 * scopes, the quiet-hours window and `resolved[]`, every type grouped by
 * category with a per-channel-group `{ effective, optOutAllowed, source }`.
 *
 * `PATCH` is a **sparse patch**: only the keys present change, an explicit
 * `null` removes an override and reverts it to the next-most-general scope, and
 * the `200` body is the full merged document. A patch that names an
 * unrecognised `typeKey` is `422 unknown_type_key`; a patch that disables a
 * channel the catalogue does not allow opting out of is `422 opt_out_not_allowed`
 * (contract §7.4, Appendix A.8); a malformed quiet-hours clock is
 * `422 validation_failed`. Validation happens **before** the upsert, so a
 * rejected patch writes nothing.
 */

/** The three routing channel groups, in catalogue order (design §1.1). */
const GROUPS: readonly ChannelGroupName[] = ["in_app", "email", "mobile"];

/** The `HH:MM` 24-hour clock gate on `quietHours.start` / `quietHours.end`. */
const clockSchema = z.string().refine(isValidClockTime, {
  message: "must be a HH:MM 24-hour time",
});

/** The sparse `PATCH` body (contract §7.4). */
const preferencesPatchSchema = z.object({
  global: z.record(z.string(), z.enum(["on", "off"])).optional(),
  byType: z
    .record(z.string(), z.union([z.record(z.string(), z.enum(["on", "off"]).nullable()), z.null()]))
    .optional(),
  byEvent: z
    .record(z.string(), z.union([z.record(z.string(), z.enum(["on", "off"]).nullable()), z.null()]))
    .optional(),
  quietHours: z
    .object({
      enabled: z.boolean().optional(),
      start: clockSchema.optional(),
      end: clockSchema.optional(),
      timeZone: z.string().optional(),
    })
    .optional(),
  digest: z
    .record(z.string(), z.union([z.enum(["instant", "quiet_period", "daily", "off"]), z.null()]))
    .optional(),
  locale: z.string().optional(),
});

/** One resolved channel group (contract §7.4). */
const resolvedChannelSchema = z.object({
  effective: z.enum(["on", "off"]),
  optOutAllowed: z.boolean(),
  source: z.enum(["default", "global", "type", "event", "transactional"]),
  resolvesTo: z.string().optional(),
  resolvesToReason: z.string().optional(),
});

/** The merged document every response carries (contract §7.4). */
export const preferencesResponseSchema = z.object({
  global: z.record(z.string(), z.enum(["on", "off"])),
  byType: z.record(z.string(), z.record(z.string(), z.enum(["on", "off"]))),
  byEvent: z.record(z.string(), z.record(z.string(), z.enum(["on", "off"]))),
  quietHours: z.object({
    enabled: z.boolean(),
    start: z.string(),
    end: z.string(),
    timeZone: z.string(),
  }),
  digest: z.record(z.string(), z.enum(["instant", "quiet_period", "daily", "off"])),
  locale: z.string(),
  resolved: z.array(
    z.object({
      category: z.string(),
      label: z.string(),
      types: z.array(
        z.object({
          typeKey: z.string(),
          label: z.string(),
          channels: z.record(z.string(), resolvedChannelSchema),
          transactional: z.boolean(),
          severity: z.string(),
        })
      ),
    })
  ),
  updatedAt: z.string().nullable(),
});

/** The `notificationPreferences` collection handle (schema §19.3). */
function preferencesCollection(db: ReturnType<typeof getDb>) {
  return platformRepo(db).collection(COLLECTIONS.notificationPreferences);
}

/** True for a plain, non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one group-keyed preference map, keeping only `on` / `off` per group. */
function asGroupPreferences(value: unknown): GroupPreferences {
  if (!isRecord(value)) {
    return {};
  }
  const map: Record<string, PreferenceValue> = {};
  for (const group of GROUPS) {
    const entry = value[group];
    if (entry === "on" || entry === "off") {
      map[group] = entry;
    }
  }
  return map;
}

/** Read one sparse scope map (`byType` / `byEvent`), keyed by typeKey / eventId. */
function asScopePreferences(value: unknown): Record<string, GroupPreferences> {
  if (!isRecord(value)) {
    return {};
  }
  const map: Record<string, GroupPreferences> = {};
  for (const [key, entry] of Object.entries(value)) {
    map[key] = asGroupPreferences(entry);
  }
  return map;
}

/** Read the digest cadence map, keeping only the four contract values. */
function asDigestPreferences(value: unknown): Record<string, DigestPreference> {
  if (!isRecord(value)) {
    return {};
  }
  const map: Record<string, DigestPreference> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === "instant" || entry === "quiet_period" || entry === "daily" || entry === "off") {
      map[key] = entry;
    }
  }
  return map;
}

/** Read the quiet-hours window, defaulting every missing field. */
function asQuietHours(value: unknown): QuietHoursSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_PREFERENCES.quietHours };
  }
  return {
    enabled: value.enabled === true,
    start: typeof value.start === "string" ? value.start : DEFAULT_PREFERENCES.quietHours.start,
    end: typeof value.end === "string" ? value.end : DEFAULT_PREFERENCES.quietHours.end,
    timeZone:
      typeof value.timeZone === "string" ? value.timeZone : DEFAULT_PREFERENCES.quietHours.timeZone,
  };
}

/**
 * Map a stored MongoDB row onto the typed preferences document.
 *
 * A missing row is the no-override baseline; `global` is completed to all three
 * groups so a sparse stored document still renders a full settings screen.
 *
 * @param row - The stored document (untested driver data), or `null`.
 * @returns The typed stored preferences.
 */
function toStoredPreferences(row: unknown): StoredPreferences {
  if (row === null || !isRecord(row)) {
    return DEFAULT_PREFERENCES;
  }
  return {
    global: { ...DEFAULT_PREFERENCES.global, ...asGroupPreferences(row.global) },
    byType: asScopePreferences(row.byType),
    byEvent: asScopePreferences(row.byEvent),
    quietHours: asQuietHours(row.quietHours),
    digest: asDigestPreferences(row.digest),
    locale: typeof row.locale === "string" ? row.locale : DEFAULT_PREFERENCES.locale,
  };
}

/** Render the stored `updatedAt` as an ISO string, or `null` when absent. */
function storedUpdatedAt(row: unknown): string | null {
  if (!isRecord(row)) {
    return null;
  }
  const value = row.updatedAt;
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** The `admin_2fa_required`-style reason a channel group refuses an opt-out. */
function optOutReason(transactional: boolean, group: string): string {
  if (transactional) {
    return "transactional";
  }
  return group === "in_app" ? "in_app" : "not_opt_outable";
}

export const GET = defineRoute({
  route: "/api/v1/me/notification-preferences",
  response: preferencesResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const db = getDb();
    const userId = new ObjectId(principal);
    const row = await preferencesCollection(db).findOne({ userId });
    const preferences = toStoredPreferences(row);
    const catalogue = await listEnabledNotificationTypes({ db });
    const merged = mergePreferences({ preferences, catalogue });

    return { body: { ...merged, updatedAt: storedUpdatedAt(row) } };
  },
});

export const PATCH = defineRoute({
  route: "/api/v1/me/notification-preferences",
  body: preferencesPatchSchema,
  response: preferencesResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const db = getDb();
    const userId = new ObjectId(principal);
    const collection = preferencesCollection(db);
    const row = await collection.findOne({ userId });
    const preferences = toStoredPreferences(row);

    const catalogue = await listEnabledNotificationTypes({ db });
    const byTypeKey = new Map(catalogue.map((type) => [type.typeKey, type]));
    const patch = ctx.body;

    // Validate before any write: an unrecognised typeKey is `unknown_type_key`.
    for (const typeKey of Object.keys(patch.byType ?? {})) {
      if (!byTypeKey.has(typeKey)) {
        throw appError("unknown_type_key", { details: { typeKey } });
      }
    }

    // Disabling a locked channel group is `opt_out_not_allowed` (design rule 7).
    for (const [typeKey, scope] of Object.entries(patch.byType ?? {})) {
      if (scope === null) {
        continue;
      }
      const type = byTypeKey.get(typeKey);
      if (type === undefined) {
        continue;
      }
      for (const [group, value] of Object.entries(scope)) {
        if (value !== "off") {
          continue;
        }
        const config = type.channelGroups.find((candidate) => candidate.group === group);
        if (config === undefined) {
          continue;
        }
        if (type.transactional || group === "in_app" || !config.optOutAllowed) {
          throw appError("opt_out_not_allowed", {
            details: {
              typeKey,
              channelGroup: group,
              reason: optOutReason(type.transactional, group),
            },
          });
        }
      }
    }

    const next = applyPreferencesPatch(preferences, patch);
    const updatedAt = new Date();
    await collection.updateOne(
      { userId },
      { $set: { userId, ...next, updatedAt } },
      { upsert: true }
    );

    const merged = mergePreferences({ preferences: next, catalogue });
    return { body: { ...merged, updatedAt: updatedAt.toISOString() } };
  },
});
