import { beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { createLogger, memoryTransport, setLogger, type MemoryTransport } from "@/server/logging";
import { fixedClock } from "@/server/runtime/clock";
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
 */

/** The stored outbox collection (schema §18.3). */
const DOMAIN_EVENTS = "domain_events";

/** A fixed instant so occurredAt/expireAt are exact, not "about a day". */
const T0 = "2026-03-01T00:00:00.000Z";

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

beforeEach(() => {
  // The settings read path is cached process-wide; clear it so each spec's
  // fake `platformSettings` document is the one the writer sees.
  invalidatePlatformSettings();
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
});
