import { describe, expect, it } from "vitest";

import {
  applyPreferencesPatch,
  DEFAULT_PREFERENCES,
  isValidClockTime,
  mergePreferences,
  type MergedPreferences,
  type PreferenceSource,
  type StoredPreferences,
} from "@/server/notifications/preferences";

import { requireType } from "../../test/factories/notification";

/**
 * Unit — the notification-preferences view model (OP-98, contract §7.4; design
 * §19.1, §19.3; ADR-0220).
 *
 * Three pure behaviours own the settings screen's correctness, so they live in
 * `@/server/notifications/preferences` rather than in the route handler:
 *
 *   U1 `mergePreferences({ preferences, catalogue, eventId? })` merges a user's
 *      stored overrides with the type catalogue and **labels the source** of each
 *      resolved channel group. The precedence chain is
 *      `transactional > byEvent > byType > global > catalogue default`
 *      (contract §7.4), and `source` is the corresponding
 *      `transactional | event | type | global | default`;
 *   U2 `applyPreferencesPatch(stored, patch)` is the **sparse** reducer behind
 *      `PATCH /me/notification-preferences`: only keys present in the patch
 *      change, an explicit `null` removes an override (reverting it to the
 *      next-most-general scope), and every absent key is left byte-for-byte
 *      untouched. The reducer is pure — it must not mutate its input;
 *   U3 `isValidClockTime(value)` is the `HH:MM` 24-hour validator gating
 *      `quietHours.start` / `quietHours.end` (contract §7.4).
 *
 * ## Contract expected of the implementation
 *
 * `@/server/notifications/preferences` exports `mergePreferences`,
 * `applyPreferencesPatch`, `isValidClockTime` and the `DEFAULT_PREFERENCES`
 * baseline (`global` all `on`, empty sparse maps, quiet hours disabled, `en-IN`),
 * plus the `PreferenceValue` / `PreferenceSource` types and the
 * `MergedPreferences` / `StoredPreferences` shapes used here.
 *
 * ## Assumptions recorded in the handoff
 *
 * - The catalogue **default** for every group is `"on"`: a preference document
 *   only ever stores *overrides*, so the absence of an override means the send
 *   happens (design §5, the `?? "on"` tail of the resolver's precedence chain).
 * - A group that cannot be opted out of (`optOutAllowed: false`, or `in_app`
 *   which is never opt-outable, or a transactional type) reports
 *   `effective: "on"` **and** `source: "default"`: a stored `off` there is not a
 *   preference at all, it is ignored (design rule 7). This is the "locked
 *   toggles are reported, not hidden" acceptance criterion.
 * - A **disabled** channel group is omitted from `channels` entirely: the type
 *   does not offer that channel, which is a routing fact, not a preference.
 */

/** A tiny structural helper so an assertion reads as prose. */
function channelOf(
  merged: MergedPreferences,
  typeKey: string,
  group: "in_app" | "email" | "mobile"
): { effective: string; optOutAllowed: boolean; source: PreferenceSource } {
  for (const category of merged.resolved) {
    for (const type of category.types) {
      if (type.typeKey !== typeKey) continue;
      const channel = type.channels[group];
      if (channel === undefined) {
        throw new Error(`no ${group} channel resolved for ${typeKey}`);
      }
      return channel;
    }
  }
  throw new Error(`type ${typeKey} is absent from the resolved catalogue`);
}

/** A preferences document with `global` overrides, built from the baseline. */
function withGlobal(overrides: Partial<Record<"in_app" | "email" | "mobile", "on" | "off">>) {
  return {
    ...DEFAULT_PREFERENCES,
    global: { ...DEFAULT_PREFERENCES.global, ...overrides },
  } satisfies StoredPreferences;
}

describe("U3 — isValidClockTime (HH:MM, 24-hour)", () => {
  it.each(["00:00", "07:00", "09:05", "12:30", "22:00", "23:59"])(
    "accepts the valid wall clock %s",
    (value) => {
      expect(isValidClockTime(value)).toBe(true);
    }
  );

  it.each([
    "",
    "24:00",
    "23:60",
    "7:00",
    "07:0",
    "0700",
    "07:00:00",
    " 07:00",
    "07:00 ",
    "12:34 pm",
    "ab:cd",
    "-1:00",
    "١٢:٣٤",
  ])("rejects the invalid wall clock %s", (value) => {
    expect(isValidClockTime(value)).toBe(false);
  });
});

describe("U2 — applyPreferencesPatch (sparse: set, null-remove, untouched)", () => {
  it("sets only the patched scope and leaves every other scope untouched", () => {
    const stored: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      byEvent: { "6702aaaaaaaaaaaaaaaaaaa1": { email: "off" } },
    };

    const next = applyPreferencesPatch(stored, { global: { email: "off" } });

    expect(next.global).toEqual({ in_app: "on", email: "off", mobile: "on" });
    expect(next.byEvent).toEqual({ "6702aaaaaaaaaaaaaaaaaaa1": { email: "off" } });
    expect(next.byType).toEqual({});
  });

  it("adds a new byType override without disturbing the existing ones", () => {
    const stored: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      byType: { "event.starting_soon": { email: "off" } },
    };

    const next = applyPreferencesPatch(stored, {
      byType: { "event.details.updated": { email: "off" } },
    });

    expect(next.byType).toEqual({
      "event.starting_soon": { email: "off" },
      "event.details.updated": { email: "off" },
    });
  });

  it("removes a whole byType override when its value is null", () => {
    const stored: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      byType: { "event.details.updated": { email: "off" } },
    };

    const next = applyPreferencesPatch(stored, { byType: { "event.details.updated": null } });

    expect(next.byType).toEqual({});
  });

  it("removes one channel inside a byType override and prunes the emptied parent", () => {
    const stored: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      byType: { "event.details.updated": { email: "off", mobile: "off" } },
    };

    const afterFirst = applyPreferencesPatch(stored, {
      byType: { "event.details.updated": { email: null } },
    });
    expect(afterFirst.byType["event.details.updated"]).toEqual({ mobile: "off" });

    const afterSecond = applyPreferencesPatch(afterFirst, {
      byType: { "event.details.updated": { mobile: null } },
    });
    expect(afterSecond.byType).toEqual({});
  });

  it("removes a whole byEvent override when its value is null", () => {
    const stored: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      byEvent: { "6702aaaaaaaaaaaaaaaaaaa1": { mobile: "off" } },
    };

    const next = applyPreferencesPatch(stored, {
      byEvent: { "6702aaaaaaaaaaaaaaaaaaa1": null },
    });

    expect(next.byEvent).toEqual({});
  });

  it("removes a digest cadence override when its value is null", () => {
    const stored: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      digest: { "attendee.matches.new": "daily" },
    };

    const next = applyPreferencesPatch(stored, { digest: { "attendee.matches.new": null } });

    expect(next.digest).toEqual({});
  });

  it("merges quietHours field-by-field, leaving the unpatched fields intact", () => {
    const stored: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "Asia/Kolkata" },
    };

    const next = applyPreferencesPatch(stored, { quietHours: { start: "21:30" } });

    expect(next.quietHours).toEqual({
      enabled: true,
      start: "21:30",
      end: "07:00",
      timeZone: "Asia/Kolkata",
    });
  });

  it("sets the locale", () => {
    const next = applyPreferencesPatch(DEFAULT_PREFERENCES, { locale: "en-US" });

    expect(next.locale).toBe("en-US");
  });

  it("does not mutate the document handed to it", () => {
    const stored = structuredClone(DEFAULT_PREFERENCES) as StoredPreferences;
    const snapshot = structuredClone(stored);

    applyPreferencesPatch(stored, {
      global: { email: "off" },
      byType: { "event.details.updated": { email: "off" } },
      digest: { "attendee.matches.new": "daily" },
      locale: "en-US",
    });

    expect(stored).toEqual(snapshot);
  });
});

describe("U1 — mergePreferences (precedence sources)", () => {
  it("labels the catalogue default when no override applies", () => {
    const merged = mergePreferences({
      preferences: DEFAULT_PREFERENCES,
      catalogue: [requireType("event.details.updated")],
    });

    expect(channelOf(merged, "event.details.updated", "email")).toEqual({
      effective: "on",
      optOutAllowed: true,
      source: "default",
    });
  });

  it("labels a global override as source global", () => {
    const merged = mergePreferences({
      preferences: withGlobal({ email: "off" }),
      catalogue: [requireType("event.details.updated")],
    });

    expect(channelOf(merged, "event.details.updated", "email")).toEqual({
      effective: "off",
      optOutAllowed: true,
      source: "global",
    });
  });

  it("labels a byType override as source type", () => {
    const merged = mergePreferences({
      preferences: {
        ...DEFAULT_PREFERENCES,
        byType: { "event.details.updated": { email: "off" } },
      },
      catalogue: [requireType("event.details.updated")],
    });

    expect(channelOf(merged, "event.details.updated", "email")).toEqual({
      effective: "off",
      optOutAllowed: true,
      source: "type",
    });
  });

  it("labels a byEvent override as source event when an event is in scope", () => {
    const merged = mergePreferences({
      preferences: {
        ...DEFAULT_PREFERENCES,
        byType: { "event.details.updated": { email: "off" } },
        byEvent: { "6702aaaaaaaaaaaaaaaaaaa1": { email: "on" } },
      },
      catalogue: [requireType("event.details.updated")],
      eventId: "6702aaaaaaaaaaaaaaaaaaa1",
    });

    expect(channelOf(merged, "event.details.updated", "email")).toEqual({
      effective: "on",
      optOutAllowed: true,
      source: "event",
    });
  });

  it("labels a transactional type as source transactional and locks it on", () => {
    const merged = mergePreferences({
      preferences: withGlobal({ email: "off", mobile: "off" }),
      catalogue: [requireType("billing.payment.failed")],
    });

    expect(channelOf(merged, "billing.payment.failed", "email")).toEqual({
      effective: "on",
      optOutAllowed: false,
      source: "transactional",
    });
  });

  it("ignores an opt-out on a group the type does not allow opting out of", () => {
    const merged = mergePreferences({
      preferences: withGlobal({ email: "off" }),
      catalogue: [requireType("event.created")],
    });

    expect(channelOf(merged, "event.created", "email")).toEqual({
      effective: "on",
      optOutAllowed: false,
      source: "default",
    });
  });

  it("keeps in_app non-opt-outable whatever the stored value says", () => {
    const merged = mergePreferences({
      preferences: withGlobal({ in_app: "off" }),
      catalogue: [requireType("event.details.updated")],
    });

    expect(channelOf(merged, "event.details.updated", "in_app")).toEqual({
      effective: "on",
      optOutAllowed: false,
      source: "default",
    });
  });

  it("omits a disabled channel group from the resolved channels", () => {
    const merged = mergePreferences({
      preferences: DEFAULT_PREFERENCES,
      catalogue: [requireType("event.details.updated")],
    });

    const category = merged.resolved.find((entry) => entry.category === "event");
    const type = category?.types.find((entry) => entry.typeKey === "event.details.updated");

    expect(type?.channels.mobile).toBeUndefined();
    expect(Object.keys(type?.channels ?? {}).sort()).toEqual(["email", "in_app"]);
  });

  it("groups the resolved catalogue by category and echoes the stored scopes verbatim", () => {
    const preferences: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      byType: { "event.details.updated": { email: "off" } },
      byEvent: { "6702aaaaaaaaaaaaaaaaaaa1": { mobile: "off" } },
      locale: "en-GB",
    };

    const merged = mergePreferences({
      preferences,
      catalogue: [requireType("event.details.updated"), requireType("billing.payment.failed")],
    });

    expect(merged.global).toEqual(preferences.global);
    expect(merged.byType).toEqual(preferences.byType);
    expect(merged.byEvent).toEqual(preferences.byEvent);
    expect(merged.locale).toBe("en-GB");

    const categories = merged.resolved.map((entry) => entry.category);
    expect([...categories].sort()).toEqual(["billing", "event"]);
    for (const category of merged.resolved) {
      expect(typeof category.label).toBe("string");
      expect(category.label.length).toBeGreaterThan(0);
    }

    const eventCategory = merged.resolved.find((entry) => entry.category === "event");
    expect(eventCategory?.types.map((entry) => entry.typeKey)).toEqual(["event.details.updated"]);
    expect(typeof eventCategory?.types[0]?.label).toBe("string");
    expect(eventCategory?.types[0]?.transactional).toBe(false);
    expect(eventCategory?.types[0]?.severity).toBe("informational");
  });
});
