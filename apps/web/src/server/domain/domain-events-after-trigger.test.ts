import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `next/server`'s `after` is the only seam these specs observe. The mock is
 * hoisted above the module graph so `@/server/domain/domain-events` binds to it
 * on import; the factory default is inert (`vi.fn()`), which is what lets a
 * spec assert the *scheduling* call without ever running the deferred work.
 */
const afterMock = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({ after: afterMock }));

import { COLLECTIONS } from "@/server/db/collections";
import { emitDomainEvent } from "@/server/domain/domain-events";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";
import { fixedClock } from "@/server/runtime/clock";
import { invalidatePlatformSettings } from "@/server/settings/platform-settings";

import { makeDomainEventInput } from "../../test/factories/domain-event";
import { makeNotificationType } from "../../test/factories/notification";
import { makeFakeMongo } from "../../test/helpers/fake-mongo";

/**
 * Unit contract — the opportunistic `after()` fan-out trigger (OP-94 §1
 * follow-up, design §1 "Triggers", ADR-0029, ADR-0095).
 *
 * The fan-out is normally drained by the
 * `/api/v1/internal/cron/notification-fanout` cron route, but a freshly emitted
 * `notifications: "pending"` outbox row should be delivered promptly rather
 * than waiting up to a minute for the next cron tick. `emitDomainEvent`
 * therefore schedules one post-response fan-out run with Next.js's `after()`
 * when — and only when — it records an event the notifications consumer owns.
 *
 * Three properties are pinned here, at the writer's boundary and without a
 * database:
 *
 *   1. An emitted event whose `dispatch.notifications` is `pending` schedules
 *      exactly one `after()` callback.
 *   2. An event the notifications consumer does not own (`skipped` — an
 *      analytics-only key, or a catalogue key with no enabled type) schedules
 *      nothing.
 *   3. Outside a Next.js request scope `after()` throws; the writer must
 *      swallow that and still return the recorded event, exactly like the
 *      health route's deferred flush
 *      (`apps/web/src/app/api/v1/health/route.ts:18-25`).
 *
 * The scheduled callback itself is deliberately not invoked: it eagerly imports
 * the fan-out and would need a real database. Whether it *runs the fan-out* is
 * covered at the cron-route level.
 */
const T0 = "2026-03-01T00:00:00.000Z";

/** A fake whose `notification_types` catalogue makes the given key pending. */
function fakeWithEnabledType(typeKey: string) {
  const fake = makeFakeMongo();
  fake.seed(COLLECTIONS.notificationTypes, [makeNotificationType({ typeKey, enabled: true })]);
  return fake;
}

beforeEach(() => {
  afterMock.mockReset();
  invalidateNotificationTypeCache();
  invalidatePlatformSettings();
});

describe("emitDomainEvent — opportunistic after() fan-out trigger", () => {
  it("schedules exactly one after() callback for a notifications-pending event", async () => {
    const fake = fakeWithEnabledType("collab.invite.accepted");

    await emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });

    expect(fake.calls.some((call) => call.method === "insertOne")).toBe(true);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(typeof afterMock.mock.calls[0]?.[0]).toBe("function");
  });

  it("schedules nothing when the event is not owned by the notifications consumer", async () => {
    const fake = makeFakeMongo();

    await emitDomainEvent(makeDomainEventInput({ eventKey: "event.viewed" }), {
      db: fake.db,
      clock: fixedClock(T0),
    });

    expect(afterMock).not.toHaveBeenCalled();
  });

  it("no-ops outside a request scope when after() throws, still recording the event", async () => {
    afterMock.mockImplementationOnce(() => {
      throw new Error("`after()` was called outside a request scope");
    });
    const fake = fakeWithEnabledType("collab.invite.accepted");

    await expect(
      emitDomainEvent(makeDomainEventInput({ eventKey: "collab.invite.accepted" }), {
        db: fake.db,
        clock: fixedClock(T0),
      })
    ).resolves.toMatchObject({ deduped: false });

    expect(fake.calls.some((call) => call.method === "insertOne")).toBe(true);
  });
});
