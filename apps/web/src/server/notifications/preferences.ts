import type { ChannelGroup, NotificationType } from "@/server/notifications/notification-types";

/**
 * The notification-preferences view model (OP-98, contract §7.4; design §19.1,
 * §19.3; ADR-0220).
 *
 * Three pure behaviours own the settings screen's correctness, so they live
 * here rather than in the route handler:
 *
 *   - {@link mergePreferences} merges a user's stored overrides with the type
 *     catalogue and **labels the source** of each resolved channel group. The
 *     precedence chain is `transactional > byEvent > byType > global > catalogue
 *     default` (contract §7.4), and `source` is the corresponding
 *     `transactional | event | type | global | default`;
 *   - {@link applyPreferencesPatch} is the **sparse** reducer behind
 *     `PATCH /me/notification-preferences`: only keys present in the patch
 *     change, an explicit `null` removes an override (reverting it to the
 *     next-most-general scope), and every absent key is left byte-for-byte
 *     untouched. The reducer is pure — it never mutates its input;
 *   - {@link isValidClockTime} is the `HH:MM` 24-hour validator gating
 *     `quietHours.start` / `quietHours.end` (contract §7.4).
 *
 * ## Two readings baked into the merge
 *
 * - The catalogue **default** for every group is `"on"` (design §5): a
 *   preference document only ever stores *overrides*. A `global` value of `"on"`
 *   therefore carries no more information than the default and is reported as
 *   `source: "default"`; a `global` `"off"` (or any more specific scope) is a
 *   real override and is labelled with its scope.
 * - A group that cannot be opted out of (`optOutAllowed: false`, `in_app` which
 *   is never opt-outable, or a transactional type) reports `effective: "on"`
 *   **and** `source: "default"`: a stored `off` there is not a preference at
 *   all, it is ignored (design rule 7). This is the "locked toggles are
 *   reported, not hidden" acceptance criterion — the entry is still present.
 */

/** A preference value (contract §7.4). */
export type PreferenceValue = "on" | "off";

/** The scope a resolved channel value won at (contract §7.4). */
export type PreferenceSource = "default" | "global" | "type" | "event" | "transactional";

/** The three routing channel groups (design §1.1). */
export type ChannelGroupName = ChannelGroup["group"];

/** A digest cadence (contract §7.4). */
export type DigestPreference = "instant" | "quiet_period" | "daily" | "off";

/** The quiet-hours window (schema §19.3). */
export interface QuietHoursSettings {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

/** A group-keyed preference scope (`global` / `byType[...]` / `byEvent[...]`). */
export type GroupPreferences = Record<string, PreferenceValue>;

/** The user's stored `notificationPreferences` document (schema §19.3). */
export interface StoredPreferences {
  global: GroupPreferences;
  byType: Record<string, GroupPreferences>;
  byEvent: Record<string, GroupPreferences>;
  quietHours: QuietHoursSettings;
  digest: Record<string, DigestPreference>;
  locale: string;
}

/** One resolved channel group as the settings screen consumes it (contract §7.4). */
export interface ResolvedChannel {
  readonly effective: PreferenceValue;
  readonly optOutAllowed: boolean;
  readonly source: PreferenceSource;
  /** Informational only: the concrete provider a `mobile` group would resolve to. */
  readonly resolvesTo?: string;
  /** Informational only: why {@link ResolvedChannel.resolvesTo} was chosen. */
  readonly resolvesToReason?: string;
}

/** One type in the resolved catalogue. */
export interface ResolvedType {
  readonly typeKey: string;
  readonly label: string;
  readonly channels: Record<string, ResolvedChannel>;
  readonly transactional: boolean;
  readonly severity: string;
}

/** One category of resolved types. */
export interface ResolvedCategory {
  readonly category: string;
  readonly label: string;
  readonly types: ResolvedType[];
}

/** The merged document (both the `GET` and the `PATCH` `200` body, contract §7.4). */
export interface MergedPreferences {
  readonly global: GroupPreferences;
  readonly byType: Record<string, GroupPreferences>;
  readonly byEvent: Record<string, GroupPreferences>;
  readonly quietHours: QuietHoursSettings;
  readonly digest: Record<string, DigestPreference>;
  readonly locale: string;
  readonly resolved: ResolvedCategory[];
}

/** A per-group patch (contract §7.4): a value sets, an explicit `null` removes. */
export type GroupPatch = Record<string, PreferenceValue | null>;

/** A quiet-hours patch: only the present fields change. */
export interface QuietHoursPatch {
  readonly enabled?: boolean | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly timeZone?: string | undefined;
}

/** The sparse `PATCH` body (contract §7.4). */
export interface PreferencesPatch {
  readonly global?: Record<string, PreferenceValue> | undefined;
  readonly byType?: Record<string, GroupPatch | null> | undefined;
  readonly byEvent?: Record<string, GroupPatch | null> | undefined;
  readonly quietHours?: QuietHoursPatch | undefined;
  readonly digest?: Record<string, DigestPreference | null> | undefined;
  readonly locale?: string | undefined;
}

/**
 * The no-override baseline (contract §7.4, design §5).
 *
 * `global` is all `on` (the send happens unless an override says otherwise), the
 * sparse maps are empty, quiet hours are disabled and the locale is `en-IN`.
 */
export const DEFAULT_PREFERENCES = {
  global: { in_app: "on", email: "on", mobile: "on" },
  byType: {},
  byEvent: {},
  quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" },
  digest: {},
  locale: "en-IN",
} as const satisfies StoredPreferences;

/** `HH:MM` 24-hour, `00:00`–`23:59` only. */
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether `value` is a valid `HH:MM` 24-hour wall clock.
 *
 * @param value - The candidate clock string.
 * @returns `true` only for `00:00`–`23:59` in exactly two-digit fields.
 */
export function isValidClockTime(value: string): boolean {
  return CLOCK_TIME.test(value);
}

/** The three routing channel groups, in catalogue order (design §1.1). */
const GROUP_NAMES: readonly ChannelGroupName[] = ["in_app", "email", "mobile"];

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
  for (const group of GROUP_NAMES) {
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
 * Map a stored MongoDB row onto the typed preferences document (schema §19.3).
 *
 * A missing row is the no-override baseline; `global` is completed to all three
 * groups so a sparse stored document still renders a full settings screen, and
 * untested driver data is narrowed per field rather than trusted. The readers are
 * exported through this one function so the preferences route and the
 * unsubscribe route (ADR-0241) interpret a stored document identically.
 *
 * @param row - The stored document (untested driver data), or `null`.
 * @returns The typed stored preferences.
 */
export function toStoredPreferences(row: unknown): StoredPreferences {
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

/**
 * Resolve one enabled channel group's effective value and source.
 *
 * @param type - The catalogue type the group belongs to.
 * @param group - The enabled channel group.
 * @param preferences - The user's stored overrides.
 * @param eventId - The event in scope for `byEvent` precedence, if any.
 * @returns The resolved `{ effective, optOutAllowed, source }`.
 */
function resolveChannel(
  type: NotificationType,
  group: ChannelGroup,
  preferences: StoredPreferences,
  eventId: string | null
): ResolvedChannel {
  // A transactional type is never opt-outable: it forces the group ON.
  if (type.transactional) {
    return { effective: "on", optOutAllowed: false, source: "transactional" };
  }

  // `in_app` is never opt-outable (design rule 7) and a group that forbids
  // opt-out ignores a stored value entirely.
  if (group.group === "in_app" || !group.optOutAllowed) {
    return { effective: "on", optOutAllowed: false, source: "default" };
  }

  const fromEvent = eventId === null ? undefined : preferences.byEvent[eventId]?.[group.group];
  const fromType = preferences.byType[type.typeKey]?.[group.group];
  const fromGlobal = preferences.global[group.group];

  if (fromEvent !== undefined) {
    return { effective: fromEvent, optOutAllowed: true, source: "event" };
  }
  if (fromType !== undefined) {
    return { effective: fromType, optOutAllowed: true, source: "type" };
  }
  if (fromGlobal !== undefined) {
    // A `global` `on` is indistinguishable from the implicit default, so it is
    // reported as `default`; a `global` `off` is a real override.
    return {
      effective: fromGlobal,
      optOutAllowed: true,
      source: fromGlobal === "off" ? "global" : "default",
    };
  }
  return { effective: "on", optOutAllowed: true, source: "default" };
}

/**
 * Merge the user's stored overrides with the catalogue (contract §7.4).
 *
 * @param input - The stored document, the catalogue and an optional event scope.
 * @returns The merged document: the stored scopes echoed verbatim plus
 *   `resolved[]`, every type grouped by category with a per-channel-group
 *   `{ effective, optOutAllowed, source }`.
 */
export function mergePreferences(input: {
  readonly preferences: StoredPreferences;
  readonly catalogue: readonly NotificationType[];
  readonly eventId?: string | null;
}): MergedPreferences {
  const { preferences, catalogue } = input;
  const eventId = input.eventId ?? null;

  const byCategory = new Map<string, ResolvedType[]>();
  for (const type of catalogue) {
    const channels: Record<string, ResolvedChannel> = {};
    for (const group of type.channelGroups) {
      if (!group.enabled) {
        continue;
      }
      channels[group.group] = resolveChannel(type, group, preferences, eventId);
    }

    const resolvedType: ResolvedType = {
      typeKey: type.typeKey,
      label: type.label ?? humaniseKey(type.typeKey),
      channels,
      transactional: type.transactional,
      severity: type.severity,
    };
    const types = byCategory.get(type.category);
    if (types === undefined) {
      byCategory.set(type.category, [resolvedType]);
    } else {
      types.push(resolvedType);
    }
  }

  const resolved: ResolvedCategory[] = [...byCategory.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, types]) => ({
      category,
      label: humaniseKey(category),
      types,
    }));

  return {
    global: preferences.global,
    byType: preferences.byType,
    byEvent: preferences.byEvent,
    quietHours: preferences.quietHours,
    digest: preferences.digest,
    locale: preferences.locale,
    resolved,
  };
}

/**
 * Apply a sparse patch to a stored document (contract §7.4).
 *
 * Only keys present in the patch change: a value sets an override, an explicit
 * `null` removes one (pruning an emptied parent), and every absent key is
 * untouched. Pure — the input is never mutated.
 *
 * @param stored - The current stored document.
 * @param patch - The sparse patch body.
 * @returns A new stored document with the patch applied.
 */
export function applyPreferencesPatch(
  stored: StoredPreferences,
  patch: PreferencesPatch
): StoredPreferences {
  const global: Record<string, PreferenceValue> = { ...stored.global };
  if (patch.global !== undefined) {
    Object.assign(global, patch.global);
  }

  return {
    global,
    byType: applyScopePatch(stored.byType, patch.byType),
    byEvent: applyScopePatch(stored.byEvent, patch.byEvent),
    quietHours: applyQuietHoursPatch(stored.quietHours, patch.quietHours),
    digest: applyDigestPatch(stored.digest, patch.digest),
    locale: patch.locale ?? stored.locale,
  };
}

/**
 * Patch the digest cadence map, copying so the input is never shared.
 *
 * @param stored - The current cadence map.
 * @param patch - The cadence patch, or `undefined` when untouched.
 * @returns A new cadence map with `null` entries removed.
 */
function applyDigestPatch(
  stored: Record<string, DigestPreference>,
  patch: Record<string, DigestPreference | null> | undefined
): Record<string, DigestPreference> {
  const next: Record<string, DigestPreference> = {};
  for (const key of new Set([...Object.keys(stored), ...Object.keys(patch ?? {})])) {
    const override = patch?.[key];
    if (override === null) {
      continue;
    }
    const value = override ?? stored[key];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Patch one sparse scope map (`byType` / `byEvent`), copying so the input is
 * never shared and pruning a parent whose last channel was removed.
 *
 * @param stored - The current scope map.
 * @param patch - The scope patch, or `undefined` when the scope is untouched.
 * @returns A new scope map.
 */
function applyScopePatch(
  stored: Readonly<Record<string, GroupPreferences>>,
  patch: Readonly<Record<string, GroupPatch | null>> | undefined
): Record<string, GroupPreferences> {
  const next: Record<string, GroupPreferences> = {};
  for (const key of new Set([...Object.keys(stored), ...Object.keys(patch ?? {})])) {
    const current = stored[key];
    const entry = patch?.[key];

    // An explicit `null` removes the whole override; an absent key copies the
    // stored value verbatim; a group patch merges channel-by-channel.
    if (entry === null) {
      continue;
    }
    if (entry === undefined) {
      if (current !== undefined) {
        next[key] = { ...current };
      }
      continue;
    }

    const merged = mergeGroupPatch(current ?? {}, entry);
    if (Object.keys(merged).length > 0) {
      next[key] = merged;
    }
  }
  return next;
}

/**
 * Merge one group patch over a scope, removing a channel whose patch value is
 * `null`.
 *
 * @param current - The stored group map for the scope.
 * @param entry - The group patch (values set, `null` removes).
 * @returns A new group map without the removed channels.
 */
function mergeGroupPatch(current: GroupPreferences, entry: GroupPatch): GroupPreferences {
  const merged: Record<string, PreferenceValue> = {};
  for (const group of new Set([...Object.keys(current), ...Object.keys(entry)])) {
    const patched = Object.prototype.hasOwnProperty.call(entry, group) ? entry[group] : undefined;
    if (patched === null) {
      continue;
    }
    const value = patched ?? current[group];
    if (value !== undefined) {
      merged[group] = value;
    }
  }
  return merged;
}

/**
 * Patch the quiet-hours window field-by-field.
 *
 * @param stored - The current window.
 * @param patch - The window patch, or `undefined` when untouched.
 * @returns A new window with only the present fields changed.
 */
function applyQuietHoursPatch(
  stored: QuietHoursSettings,
  patch: QuietHoursPatch | undefined
): QuietHoursSettings {
  if (patch === undefined) {
    return { ...stored };
  }
  return {
    enabled: patch.enabled ?? stored.enabled,
    start: patch.start ?? stored.start,
    end: patch.end ?? stored.end,
    timeZone: patch.timeZone ?? stored.timeZone,
  };
}

/**
 * Humanise a dotted/underscored key into a non-empty display label.
 *
 * The seed stores no `label`/`description` copy (`notification-types.values.ts`),
 * so labels are a read-route projection. This mirrors the shape already used by
 * `notification-templates.values.ts` (`auth.otp.email.requested` →
 * `Auth Otp Email Requested`); real product copy is a later decision.
 *
 * @param key - A `typeKey` or category name.
 * @returns A capitalised, space-separated label.
 */
export function humaniseKey(key: string): string {
  return key
    .split(".")
    .map((segment) => segment.split("_").map(capitalise).join(" "))
    .join(" ");
}

/**
 * Capitalise the first letter of one word.
 *
 * @param word - One underscore-delimited segment.
 * @returns The word with an upper-cased first letter.
 */
function capitalise(word: string): string {
  if (word.length === 0) {
    return word;
  }
  return word.charAt(0).toUpperCase() + word.slice(1);
}
