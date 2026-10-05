import { describe, expect, it, vi } from "vitest";

import {
  interpolateDedupeKey,
  resolveRecipients,
  type RecipientRepository,
  type ResolveRecipientsInput,
} from "@/server/notifications/fan-out";
import type { NotificationAudience } from "@/server/notifications/notification-types";

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
