import { beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { emitDomainEvent, claimPendingEvents } from "@/server/domain/domain-events";
import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { fixedClock } from "@/server/runtime/clock";
import { addMilliseconds } from "@/server/runtime/time";
import {
  invalidatePlatformSettings,
  PLATFORM_SETTINGS_DEFAULTS,
} from "@/server/settings/platform-settings";

import {
  makeDomainEventInput,
  makePlatformSettingsDocument,
} from "../../test/factories/domain-event";
import { makeNotificationType } from "../../test/factories/notification";
import { makeFakeMongo, type FakeMongo } from "../../test/helpers/fake-mongo";

/**
 * Unit contract — `emitDomainEvent`, the single outbox write point (OP-88,
 * schema §18.3, contract §7.7).
 *
 * `emitDomainEvent(input, options?)` is the one door business code uses to
 * record a domain event; notification fan-out, analytics rollup and queue
 * publishing are independent consumers that read the row later (schema §18.3).
 * These specs pin the writer's *boundary* behaviour with the recording fake
 * `Db`: the event-key gate (catalogue ∪ analytics-only), the payload deep scan
 * that keeps contact details out of the log, the `expireAt` derived from
 * `platformSettings.retention.domainEventDays`, and the per-consumer `dispatch`
 * flags. Real persistence, transactions, dedupe and claiming are proven against
 * a replica set in `src/test/integration/domain-events.test.ts`.
 *
 * Contract expected of the implementation:
 *
 *   @/server/domain/domain-events
 *     emitDomainEvent(input: DomainEventInput, options?: {
 *       db?: Db; clock?: Clock; session?: ClientSession;
 *     }): Promise<{ deduped: boolean; id: string | null }>
 *
 *   Rejections carry a `code`:
 *     "unknown_event_key"       — eventKey is neither a §7.6 typeKey nor an
 *                                 analytics-only key
 *     "forbidden_payload_field" — payload nests a contact/secret/vector key
 *                                 (email, phone, token, otp, embedding, vector,
 *                                 password) at any depth
 *
 *   The clock stamps `occurredAt`; `expireAt` = occurredAt +
 *   settings.retention.domainEventDays. Logs `domain_event.emitted` at info
 *   with eventKey/tenantId/subjectRef only — never the payload.
 *
 *   Settings seam: the writer MUST read the singleton through the injected
 *   `db` — `getPlatformSettings({ db, clock })` — not the ambient/real client,
 *   so the unit specs' `platformSettings` document on the recording fake is the
 *   one it observes. The `getPlatformSettings` cache is process-wide, so specs
 *   call `invalidatePlatformSettings()` in `beforeEach`.
 */

/** The stored outbox collection (schema §18.3). */
const DOMAIN_EVENTS = "domain_events";

/** A fixed instant so occurredAt/expireAt are exact, not "about a day". */
const T0 = "2026-03-01T00:00:00.000Z";

/** The ISO instant `plusMs` after `T0` — used to cross the 30 s TTL window. */
function at(plusMs: number): string {
  return addMilliseconds(fixedClock(T0).now(), plusMs).toISOString();
}

/** The stored document fields these specs inspect. */
interface InsertedEvent {
  readonly eventKey: string;
  readonly tenantId: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly expireAt: Date;
  readonly dispatch: {
    readonly notifications: string;
    readonly analytics: string;
    readonly queue: string;
  };
  readonly dedupeKey?: string;
}

/** Read the document the writer handed to `insertOne`, failing loudly if none. */
function insertedEvent(fake: FakeMongo): InsertedEvent {
  const call = fake.lastCall("insertOne");
  if (call === undefined) {
    throw new Error("emitDomainEvent never inserted a domain event");
  }
  if (call.collection !== DOMAIN_EVENTS) {
    throw new Error(
      `domain events must be written to the "${DOMAIN_EVENTS}" collection, got "${call.collection}"`
    );
  }
  return call.args[0] as InsertedEvent;
}

/** Capture logs into a memory transport so a spec can inspect them. */
function installMemoryLogger(): MemoryTransport {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "info",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
  return sink;
}

/**
 * Build a recording fake whose `domain_events` handle replaces named driver
 * methods.
 *
 * `emitDomainEvent` and `claimPendingEvents` reach the driver only through
 * `db.collection("domain_events")`, so overriding one method there lets a spec
 * drive a driver failure or a malformed stored row without a replica set.
 *
 * @param overrides - Driver methods to replace on the `domain_events` handle.
 * @returns The fake, with its `calls`, `seed` and `lastCall` helpers.
 */
function fakeDbWithDomainEvents(overrides: Record<string, unknown>): FakeMongo {
  const fake = makeFakeMongo();
  const baseCollection = (fake.db.collection as (name: string) => unknown).bind(fake.db);
  (fake.db as unknown as { collection: (name: string) => unknown }).collection = (name: string) => {
    const handle = baseCollection(name) as Record<string, unknown>;
    return name === DOMAIN_EVENTS ? { ...handle, ...overrides } : handle;
  };
  return fake;
}

/** How many reads the fake recorded against the `notification_types` catalogue. */
function notificationTypeReads(fake: FakeMongo): number {
  return fake.calls.filter(
    (call) =>
      call.collection === COLLECTIONS.notificationTypes &&
      (call.method === "find" || call.method === "findOne")
  ).length;
}

beforeEach(() => {
  // Both read paths are cached process-wide; clear them so each spec's fake
  // `platformSettings` / `notification_types` documents are the ones the writer
  // sees.
  invalidatePlatformSettings();
  invalidateNotificationTypeCache();
});

describe("emitDomainEvent — the eventKey gate", () => {
  it("U1: rejects an eventKey that is neither a notification catalogue key nor an analytics-only key", async () => {
    const fake = makeFakeMongo();

    await expect(
      emitDomainEvent(makeDomainEventInput({ eventKey: "totally.unknown.event" }), {
        db: fake.db,
        clock: fixedClock(T0),
      })
    ).rejects.toMatchObject({ code: "unknown_event_key" });

    expect(fake.calls.some((call) => call.method === "insertOne")).toBe(false);
  });

  it("accepts a registered analytics-only key and records it with notifications skipped", async () => {
    const fake = makeFakeMongo();

    await emitDomainEvent(makeDomainEventInput({ eventKey: "event.viewed" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });

    expect(insertedEvent(fake).eventKey).toBe("event.viewed");
    expect(insertedEvent(fake).dispatch.notifications).toBe("skipped");
  });
});

describe("emitDomainEvent — payload deep scan", () => {
  it.each(["email", "phone", "token", "otp", "embedding", "vector", "password"])(
    "U2: rejects a payload carrying a forbidden %s key at any depth",
    async (forbidden) => {
      const fake = makeFakeMongo();

      await expect(
        emitDomainEvent(
          makeDomainEventInput({
            payload: {
              inviteId: "inv_1",
              recipient: { contact: { [forbidden]: "leak" } },
            },
          }),
          { db: fake.db, clock: fixedClock(T0) }
        )
      ).rejects.toMatchObject({ code: "forbidden_payload_field" });

      expect(fake.calls.some((call) => call.method === "insertOne")).toBe(false);
    }
  );

  it("accepts a payload whose nested keys are all resolvable identifiers", async () => {
    const fake = makeFakeMongo();

    await emitDomainEvent(
      makeDomainEventInput({
        payload: { invite: { id: "inv_1", role: "co_organizer" }, count: 3 },
      }),
      { db: fake.db, clock: fixedClock(T0) }
    );

    expect(insertedEvent(fake).payload).toEqual({
      invite: { id: "inv_1", role: "co_organizer" },
      count: 3,
    });
  });

  it("accepts a payload whose keys merely CONTAIN a forbidden token as a substring", async () => {
    const fake = makeFakeMongo();

    // ADR-0029 §3: the scan is an exact key match, not a substring match. A
    // buggy `key.includes(token)` scan would wrongly reject this payload.
    await emitDomainEvent(
      makeDomainEventInput({
        payload: { emailVerified: true, phoneNumber: "placeholder", tokenCount: 2 },
      }),
      { db: fake.db, clock: fixedClock(T0) }
    );

    expect(insertedEvent(fake).payload).toEqual({
      emailVerified: true,
      phoneNumber: "placeholder",
      tokenCount: 2,
    });
  });

  it("rejects a payload carrying a forbidden key inside an array element", async () => {
    const fake = makeFakeMongo();

    await expect(
      emitDomainEvent(
        makeDomainEventInput({ payload: { recipients: [{ id: "u_1" }, { email: "leak" }] } }),
        { db: fake.db, clock: fixedClock(T0) }
      )
    ).rejects.toMatchObject({ code: "forbidden_payload_field" });

    expect(fake.calls.some((call) => call.method === "insertOne")).toBe(false);
  });

  it("accepts a payload whose array elements are all resolvable identifiers", async () => {
    const fake = makeFakeMongo();

    await emitDomainEvent(
      makeDomainEventInput({ payload: { recipients: [{ id: "u_1" }, { id: "u_2" }] } }),
      { db: fake.db, clock: fixedClock(T0) }
    );

    expect(insertedEvent(fake).payload).toEqual({ recipients: [{ id: "u_1" }, { id: "u_2" }] });
  });
});

describe("emitDomainEvent — timestamps and retention", () => {
  it("U3: computes expireAt from platformSettings.retention.domainEventDays", async () => {
    const fake = makeFakeMongo();
    fake.seed("platformSettings", [
      makePlatformSettingsDocument({
        retention: { ...PLATFORM_SETTINGS_DEFAULTS.retention, domainEventDays: 90 },
      }),
    ]);
    invalidatePlatformSettings();

    await emitDomainEvent(makeDomainEventInput(), { db: fake.db, clock: fixedClock(T0) });

    const inserted = insertedEvent(fake);
    expect(inserted.occurredAt.toISOString()).toBe(T0);
    // 2026-03-01 + 90 days.
    expect(inserted.expireAt.toISOString()).toBe("2026-05-30T00:00:00.000Z");
  });

  it("uses the documented 180-day window when no settings document is stored", async () => {
    const fake = makeFakeMongo();

    await emitDomainEvent(makeDomainEventInput(), { db: fake.db, clock: fixedClock(T0) });

    // 2026-03-01 + 180 days.
    expect(insertedEvent(fake).expireAt.toISOString()).toBe("2026-08-28T00:00:00.000Z");
  });
});

describe("emitDomainEvent — dispatch flags", () => {
  it("U4: marks notifications skipped when no notification type exists for the event", async () => {
    const fake = makeFakeMongo();

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });

    expect(insertedEvent(fake).dispatch).toEqual({
      notifications: "skipped",
      analytics: "pending",
      queue: "not_applicable",
    });
  });

  it("marks notifications pending when an enabled notification type exists for the event", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });

    expect(insertedEvent(fake).dispatch).toEqual({
      notifications: "pending",
      analytics: "pending",
      queue: "not_applicable",
    });
  });

  it("marks notifications skipped when the matching notification type is disabled", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: false }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });

    expect(insertedEvent(fake).dispatch.notifications).toBe("skipped");
  });
});

describe("emitDomainEvent — the notification-type cache (OP-88 follow-up D1)", () => {
  it("U5: reads notification_types once across two emits within the TTL window", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });
    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });

    expect(notificationTypeReads(fake)).toBe(1);
  });

  it("U6: keeps seeing the cached enabled set inside the 30 s window", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });
    expect(insertedEvent(fake).dispatch.notifications).toBe("pending");

    // The operator disables the type behind the cache's back; the change is not
    // observed inside the accepted staleness window.
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: false }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(at(10_000)),
    });

    expect(insertedEvent(fake).dispatch.notifications).toBe("pending");
  });

  it("U7: observes the change at exactly the 30 s boundary", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });
    expect(insertedEvent(fake).dispatch.notifications).toBe("pending");

    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: false }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(at(30_000)),
    });

    expect(insertedEvent(fake).dispatch.notifications).toBe("skipped");
  });

  it("U8: invalidateNotificationTypeCache forces the change to be observed immediately", async () => {
    const fake = makeFakeMongo();
    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: true }),
    ]);

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });
    expect(insertedEvent(fake).dispatch.notifications).toBe("pending");

    fake.seed(COLLECTIONS.notificationTypes, [
      makeNotificationType({ typeKey: "collab.invite.accepted", enabled: false }),
    ]);
    invalidateNotificationTypeCache();

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(at(1000)),
    });

    expect(insertedEvent(fake).dispatch.notifications).toBe("skipped");
  });
});

describe("emitDomainEvent — logging", () => {
  it("logs domain_event.emitted with identifiers only, never the payload", async () => {
    const sink = installMemoryLogger();
    const fake = makeFakeMongo();

    await emitDomainEvent(
      makeDomainEventInput({ payload: { inviteId: "inv_1", marker: "payload-marker-9f3a" } }),
      { db: fake.db, clock: fixedClock(T0) }
    );

    const entry = sink.entries.find((candidate) => candidate.event === "domain_event.emitted");
    expect(entry).toBeDefined();
    expect(entry?.eventKey).toBe("collab.invite.accepted");
    expect(entry?.tenantId).toBe("t_1");
    expect(JSON.stringify(sink.entries)).not.toContain("payload-marker-9f3a");
  });

  it("logs domain_event.emitted carrying the subjectRef kind and id", async () => {
    const sink = installMemoryLogger();
    const fake = makeFakeMongo();

    await emitDomainEvent(makeDomainEventInput(), { db: fake.db, clock: fixedClock(T0) });

    const entry = sink.entries.find((candidate) => candidate.event === "domain_event.emitted");
    expect(entry).toBeDefined();
    expect(entry?.subjectRef).toEqual({ kind: "invitation", id: "inv_1" });
  });
});

describe("emitDomainEvent — input validation", () => {
  it("rejects an input that fails the structural schema", async () => {
    const fake = makeFakeMongo();

    await expect(
      emitDomainEvent(makeDomainEventInput({ tenantId: "" }), {
        db: fake.db,
        clock: fixedClock(T0),
      })
    ).rejects.toMatchObject({ code: "invalid_domain_event" });

    expect(fake.calls.some((call) => call.method === "insertOne")).toBe(false);
  });
});

describe("claimPendingEvents — driver failures and malformed rows", () => {
  it("propagates a non-duplicate insert failure instead of reporting a dedupe", async () => {
    const writeError = new Error("primary stepped down");
    const fake = fakeDbWithDomainEvents({ insertOne: () => Promise.reject(writeError) });

    await expect(
      emitDomainEvent(makeDomainEventInput(), { db: fake.db, clock: fixedClock(T0) })
    ).rejects.toBe(writeError);
  });

  it("rejects a claimed row that is not a stored domain event", async () => {
    const fake = fakeDbWithDomainEvents({
      findOneAndUpdate: () => Promise.resolve({ eventKey: "collab.invite.accepted" }),
    });

    await expect(
      claimPendingEvents("notifications", 1, { db: fake.db, clock: fixedClock(T0) })
    ).rejects.toThrow(/ObjectId/);
  });
});
