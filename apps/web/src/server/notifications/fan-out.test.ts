import { describe, expect, it, vi } from "vitest";

import {
  interpolateDedupeKey,
  resolveRecipients,
  type RecipientRepository,
  type ResolveRecipientsInput,
} from "@/server/notifications/fan-out";
import * as fanOutModule from "@/server/notifications/fan-out";
import type { ChannelGroup, NotificationAudience } from "@/server/notifications/notification-types";
import {
  DEFAULT_MOBILE_CANDIDATES,
  type ResolvedChannel,
} from "@/server/notifications/resolve-channel";

import { makeNotificationType } from "../../test/factories/notification";

/**
 * The notification fan-out consumer — unit contract (OP-94, design §2, §5, §6;
 * ADR-0090).
 *
 * The fan-out turns one claimed `domainEvents` row into, per recipient, the
 * right in-app feed row and the right outbound dispatches. This spec pins the
 * two pure/semi-pure pieces that must be testable with **zero** Mongo, clock or
 * network access:
 *
 *   U1  `resolveRecipients` maps a type's `audiences[]` to the user ids that
 *       should receive it, reading memberships/contacts through an injected
 *       {@link RecipientRepository} port (design §2: "audience is derived at
 *       send time, never stored").
 *   U2  the actor is never a recipient of their own event (design §4.5/§4.6).
 *   U3  `interpolateDedupeKey` expands a type's `dedupe.keyTemplate`
 *       (`"{typeKey}:{profileId}"`) into the concrete key the dispatch ledger's
 *       unique index enforces (design §6, schema §19.5).
 *
 * ## Contract expected of the implementation
 *
 * Module: `@/server/notifications/fan-out` (new).
 *
 * ```ts
 * interface RecipientRepository {
 *   listEventRoleMembers(input: {
 *     tenantId: string;
 *     eventId: string;
 *     roles: readonly ("organizer" | "co_organizer")[];
 *   }): Promise<readonly string[]>;
 *   listIdentifiedAttendeeUserIds(input: {
 *     tenantId: string;
 *     eventId: string;
 *   }): Promise<readonly string[]>;
 *   getBillingContactUserId(input: { tenantId: string }): Promise<string | null>;
 *   listPlatformAdminUserIds(): Promise<readonly string[]>;
 * }
 *
 * interface ResolveRecipientsInput {
 *   typeRow: NotificationType;
 *   tenantId: string;
 *   eventId: string | null;
 *   actorUserId: string | null;
 *   subjectUserId: string | null;
 *   repository: RecipientRepository;
 * }
 *
 * resolveRecipients(input): Promise<readonly string[]>
 * interpolateDedupeKey(template: string | null, vars): string | null
 * ```
 *
 * ## Assumptions (ADR-0090)
 *
 * - Audience → source mapping is fixed: `organizer`/`co_organizer` →
 *   `listEventRoleMembers` (one call, roles in canonical order); `attendee_identified`
 *   → `listIdentifiedAttendeeUserIds`; `billing_contact` → `getBillingContactUserId`;
 *   `platform_admin` → `listPlatformAdminUserIds`; `attendee_anonymous` → nobody
 *   (design §2: "no verified contact, no account → deliberately unreachable").
 * - `organizer`/`co_organizer`/`attendee_identified` are event-scoped: with no
 *   `eventId` they contribute nothing and their repository method is not called.
 * - A `subjectUserId` is always included (the notification is about them), then
 *   the actor is excluded.
 */

/** A fixed instant so nothing in this spec depends on the wall clock. */
const BASE: Omit<ResolveRecipientsInput, "typeRow" | "repository"> = {
  tenantId: "t_1",
  eventId: "ev_1",
  actorUserId: null,
  subjectUserId: null,
};

/** Wrap a fixed value in a resolved promise (repo methods are async by contract). */
function promised<T>(value: T): () => Promise<T> {
  return () => Promise.resolve(value);
}

/** Build the injected recipient source with every method safe by default. */
function makeRepository(overrides: Partial<RecipientRepository> = {}): RecipientRepository {
  return {
    listEventRoleMembers: vi.fn(promised<readonly string[]>([])),
    listIdentifiedAttendeeUserIds: vi.fn(promised<readonly string[]>([])),
    getBillingContactUserId: vi.fn(promised<string | null>(null)),
    listPlatformAdminUserIds: vi.fn(promised<readonly string[]>([])),
    ...overrides,
  };
}

/** A type row carrying only the audiences under test. */
function typeWith(audiences: readonly NotificationAudience[]) {
  return makeNotificationType({ audiences: [...audiences] });
}

/** Assemble a `resolveRecipients` input. */
function makeInput(overrides: Partial<ResolveRecipientsInput> = {}): ResolveRecipientsInput {
  return {
    ...BASE,
    typeRow: typeWith(["organizer"]),
    repository: makeRepository(),
    ...overrides,
  };
}

describe("resolveRecipients — audience resolution (U1)", () => {
  it("resolves an organizer audience to the event's active organizers", async () => {
    const repository = makeRepository({
      listEventRoleMembers: vi.fn(promised(["u_org"])),
    });

    const recipients = await resolveRecipients(
      makeInput({ typeRow: typeWith(["organizer"]), repository })
    );

    expect(recipients).toEqual(["u_org"]);
    expect(repository.listEventRoleMembers).toHaveBeenCalledWith({
      tenantId: "t_1",
      eventId: "ev_1",
      roles: ["organizer"],
    });
  });

  it("resolves a co_organizer audience to the event's active co-organizers", async () => {
    const repository = makeRepository({
      listEventRoleMembers: vi.fn(promised(["u_co"])),
    });

    const recipients = await resolveRecipients(
      makeInput({ typeRow: typeWith(["co_organizer"]), repository })
    );

    expect(recipients).toEqual(["u_co"]);
    expect(repository.listEventRoleMembers).toHaveBeenCalledWith({
      tenantId: "t_1",
      eventId: "ev_1",
      roles: ["co_organizer"],
    });
  });

  it("resolves an attendee_identified audience to the event's identified attendees", async () => {
    const repository = makeRepository({
      listIdentifiedAttendeeUserIds: vi.fn(promised(["u_att"])),
    });

    const recipients = await resolveRecipients(
      makeInput({ typeRow: typeWith(["attendee_identified"]), repository })
    );

    expect(recipients).toEqual(["u_att"]);
    expect(repository.listIdentifiedAttendeeUserIds).toHaveBeenCalledWith({
      tenantId: "t_1",
      eventId: "ev_1",
    });
  });

  it("resolves a billing_contact audience to the tenant's billing contact", async () => {
    const repository = makeRepository({
      getBillingContactUserId: vi.fn(promised("u_bill")),
    });

    const recipients = await resolveRecipients(
      makeInput({ typeRow: typeWith(["billing_contact"]), repository })
    );

    expect(recipients).toEqual(["u_bill"]);
    expect(repository.getBillingContactUserId).toHaveBeenCalledWith({ tenantId: "t_1" });
  });

  it("resolves a platform_admin audience to the platform administrators", async () => {
    const repository = makeRepository({
      listPlatformAdminUserIds: vi.fn(promised(["u_admin"])),
    });

    const recipients = await resolveRecipients(
      makeInput({ typeRow: typeWith(["platform_admin"]), repository })
    );

    expect(recipients).toEqual(["u_admin"]);
    expect(repository.listPlatformAdminUserIds).toHaveBeenCalledTimes(1);
  });

  it("resolves an attendee_anonymous audience to nobody", async () => {
    const repository = makeRepository({
      listIdentifiedAttendeeUserIds: vi.fn(promised(["u_should_not_leak"])),
    });

    const recipients = await resolveRecipients(
      makeInput({ typeRow: typeWith(["attendee_anonymous"]), repository })
    );

    expect(recipients).toEqual([]);
    expect(repository.listIdentifiedAttendeeUserIds).not.toHaveBeenCalled();
  });

  it("unions several audiences, preserving first-seen order and deduping a user", async () => {
    const repository = makeRepository({
      listEventRoleMembers: vi.fn(promised(["u_a", "u_shared"])),
      listIdentifiedAttendeeUserIds: vi.fn(promised(["u_shared", "u_b"])),
    });

    const recipients = await resolveRecipients(
      makeInput({ typeRow: typeWith(["organizer", "attendee_identified"]), repository })
    );

    expect(recipients).toEqual(["u_a", "u_shared", "u_b"]);
  });

  it("skips event-scoped audiences when the event id is absent", async () => {
    const repository = makeRepository({
      getBillingContactUserId: vi.fn(promised("u_bill")),
    });

    const recipients = await resolveRecipients(
      makeInput({
        typeRow: typeWith(["organizer", "co_organizer", "attendee_identified", "billing_contact"]),
        eventId: null,
        repository,
      })
    );

    expect(recipients).toEqual(["u_bill"]);
    expect(repository.listEventRoleMembers).not.toHaveBeenCalled();
    expect(repository.listIdentifiedAttendeeUserIds).not.toHaveBeenCalled();
  });

  it("includes the subject user even when the audience resolves to nobody", async () => {
    const recipients = await resolveRecipients(
      makeInput({
        typeRow: typeWith(["platform_admin"]),
        eventId: null,
        subjectUserId: "u_subject",
        repository: makeRepository(),
      })
    );

    expect(recipients).toEqual(["u_subject"]);
  });
});

describe("resolveRecipients — actor exclusion (U2)", () => {
  it("excludes the actor from recipients even when a repository returns them", async () => {
    const repository = makeRepository({
      listEventRoleMembers: vi.fn(promised(["u_actor", "u_peer"])),
      listIdentifiedAttendeeUserIds: vi.fn(promised(["u_actor", "u_attendee"])),
    });

    const recipients = await resolveRecipients(
      makeInput({
        typeRow: typeWith(["organizer", "co_organizer", "attendee_identified"]),
        actorUserId: "u_actor",
        repository,
      })
    );

    expect(recipients).toEqual(["u_peer", "u_attendee"]);
  });

  it("excludes the actor from the subject-derived recipient", async () => {
    const recipients = await resolveRecipients(
      makeInput({
        typeRow: typeWith(["attendee_identified"]),
        subjectUserId: "u_actor",
        actorUserId: "u_actor",
        repository: makeRepository(),
      })
    );

    expect(recipients).toEqual([]);
  });
});

describe("interpolateDedupeKey — template expansion (U3)", () => {
  it.each([
    ["null template yields no key", null, {}, null],
    [
      "expands {typeKey} and {profileId}",
      "{typeKey}:{profileId}",
      { typeKey: "attendee.matches.ready", profileId: "prof_1" },
      "attendee.matches.ready:prof_1",
    ],
    [
      "a literal template is returned unchanged",
      "auth.signin.new_device",
      {},
      "auth.signin.new_device",
    ],
  ] as const)("%s", (_name, template, vars, expected) => {
    expect(interpolateDedupeKey(template, vars)).toBe(expected);
  });

  it("throws when the template references a variable that was not supplied", () => {
    expect(() =>
      interpolateDedupeKey("{typeKey}:{deviceId}", { typeKey: "auth.signin.new_device" })
    ).toThrow(/deviceId/);
  });
});

/**
 * The channel a **pre-selection** skip/defer/digest records on its dispatch row
 * (OP-94 follow-up; ADR-0094, ADR-0110).
 *
 * `fanOutToRecipient` decides some outcomes before any candidate is chosen
 * (a quiet-hours `defer`, a throttled `skip`, an outbound `digest`). Those arms
 * persist `writeSkip(..., groupChannel(group), ...)` /
 * `writeDigestQueued(..., groupChannel(group))`, so `groupChannel` is what the
 * ledger's `channel` column reports for a message that was never routed.
 *
 * For a `mobile` group it must mirror the resolver's candidate order
 * (`resolve-channel.ts` `candidateChannels`): `candidates[0]`, else
 * `DEFAULT_MOBILE_CANDIDATES[0]`. PR #190 replaced a hard-coded `"sms"` fallback
 * with the resolver's exported default (`"whatsapp"`); without this pin that
 * regression can return silently and the ledger would name a channel the
 * resolver would never have tried first.
 *
 * ## Contract expected of the implementation (authorized test seam, ADR-0110)
 *
 * ```ts
 * // @/server/notifications/fan-out
 * export function groupChannel(group: ChannelGroup): ResolvedChannel;
 * ```
 *
 * ## Why an exported helper rather than a stored-row assertion
 *
 * The branch is unreachable from any stored document: `processEvent` reads a
 * type row through `loadTypeRow` → `notificationTypeSchema`, and
 * `channelGroupSchema` rejects an **enabled** `mobile` group that omits
 * `candidates`, while `fanOutToRecipient` skips a **disabled** group. A test that
 * injected such a row would therefore observe **zero** dispatch rows and fail
 * for the wrong reason (probe recorded in ADR-0110). The card authorised exporting the pure
 * selector instead; the helper is a total function of its argument and the
 * production call sites are unchanged.
 */

/** The seam's expected signature — the only contract this section adds. */
type GroupChannelSeam = (group: ChannelGroup) => ResolvedChannel;

/** The module plus the seam this spec requires it to expose. */
const fanOut = fanOutModule as typeof fanOutModule & {
  readonly groupChannel?: GroupChannelSeam;
};

/**
 * Call the `groupChannel` seam.
 *
 * @param group - The channel group whose recorded channel is under test.
 * @returns The channel the fan-out would persist for a pre-selection outcome.
 * @throws When the module does not export the seam — reported as the intended
 *   RED for this section instead of an opaque `not a function` TypeError.
 */
function groupChannelOf(group: ChannelGroup): ResolvedChannel {
  const seam = fanOut.groupChannel;

  if (seam === undefined) {
    throw new Error(
      "fan-out must export `groupChannel(group: ChannelGroup): ResolvedChannel` " +
        "(authorized test seam, ADR-0110) — the pre-selection skip channel cannot be pinned otherwise"
    );
  }

  return seam(group);
}

/** A mobile group with the given candidate list (omitted = the fallback case). */
function mobileGroup(candidates?: readonly ("whatsapp" | "sms")[]): ChannelGroup {
  if (candidates === undefined) {
    // A group with no declared candidate order: schema-invalid when enabled,
    // which is exactly the defensive branch under test.
    return { group: "mobile", enabled: true, optOutAllowed: false, strategy: "first_eligible" };
  }

  return {
    group: "mobile",
    enabled: true,
    optOutAllowed: false,
    candidates: [...candidates],
    strategy: "first_eligible",
  };
}

describe("groupChannel — channel recorded for a pre-selection outcome (U4)", () => {
  it("exports the channel-selection seam these pins need", () => {
    expect(fanOut.groupChannel).toBeTypeOf("function");
  });

  it("falls back to the resolver's default mobile candidate when the group declares none", () => {
    expect(groupChannelOf(mobileGroup())).toBe(DEFAULT_MOBILE_CANDIDATES[0]);
  });

  it("names `whatsapp` for a mobile group with no declared candidates", () => {
    // Literal assertion: the default is a contract value, so re-hard-coding the
    // pre-PR-#190 `"sms"` fallback must fail here even if the constant moves.
    expect(groupChannelOf(mobileGroup())).toBe("whatsapp");
  });

  it.each([
    [["whatsapp", "sms"] as const, "whatsapp"],
    [["sms", "whatsapp"] as const, "sms"],
    [["sms"] as const, "sms"],
  ])("records the group's first declared candidate (%j) as %s", (candidates, expected) => {
    expect(groupChannelOf(mobileGroup(candidates))).toBe(expected);
  });

  it.each([["in_app"], ["email"]] as const)(
    "records the single-member %s group as its own channel",
    (group) => {
      expect(groupChannelOf({ group, enabled: true, optOutAllowed: false })).toBe(group);
    }
  );
});
