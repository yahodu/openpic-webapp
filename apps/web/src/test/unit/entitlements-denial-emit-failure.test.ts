import type { ClientSession } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isAppError } from "@/server/http/errors";
import {
  createLogger,
  getLogger,
  memoryTransport,
  setLogger,
  type Logger,
  type MemoryTransport,
} from "@/server/logging";
import { fixedClock } from "@/server/runtime/clock";
import { consumeEntitlement, type EntitlementEventEmitter } from "@/server/services/entitlements";

import { makeSubscription, makeUsageCounter } from "../factories/entitlements";
import { makeEntitlement, makePlan } from "../factories/plan";
import { makeFakeMongo, type FakeMongo } from "../helpers/fake-mongo";

/**
 * Unit contract — a denial is authoritative even when the outbox emit fails
 * (OP-103 follow-up F2, schema §14.2/§14.3, contract §0.14).
 *
 * `consumeEntitlement` is the enforcement point. On a denial it records the
 * blocked action (`recordDenial` logs `entitlement.denied` and emits
 * `usage.action.blocked` **outside** the caller's session) and then throws the
 * Appendix A `AppError`. Because the record is awaited before the throw, a
 * failing outbox emit must NOT replace that `AppError`: §0.14 answers a denial
 * `402`/`403` with the upgrade CTA, so a swallowed emit failure that leaked out
 * would turn the denial into an unmapped `500` and strip the client's reason.
 *
 * ## The emit-failure decision (recorded here on purpose)
 *
 * 1. The denial always wins. When `options.emit` rejects, `consumeEntitlement`
 *    still throws the Appendix A `AppError` for the denial —
 *    `plan_limit_exceeded` (403), `payment_required` (402) or
 *    `feature_not_available` (403) — never the emitter's error.
 * 2. The emit failure is still **observable**: it is swallowed by the denial
 *    path and recorded as a `warn`-level log entry with
 *    `event: "entitlement.denied.emit_failed"` (the original error attached),
 *    so an operator can see the `usage.action.blocked` row that was lost. It is
 *    never re-thrown.
 * 3. The denial is still recorded as before: the `entitlement.denied` `info`
 *    line is written and the blocked emit is attempted exactly once.
 *
 * The outbox is injected through `options.emit` (the seam a unit spec uses to
 * observe the denial path without booting the outbox), so these pins are pure
 * unit behaviour; the atomic consumption itself stays in
 * `src/test/integration/entitlements.test.ts`.
 */

/** The tenant every fixture is scoped to. */
const TENANT = "t_op103_emit_fail";

/** The fixed instant the specs reason about (2026-09-15, mid-month). */
const NOW = "2026-09-15T10:00:00.000Z";

/** The `events.active` key the limit-denial fixtures gate on. */
const KEY = "events.active";

/** The disabled feature the `feature_not_available` fixture gates on. */
const FEATURE_KEY = "originals.download";

/** The message the injected emitter rejects with, so a leak is unambiguous. */
const EMIT_FAILURE = "outbox write failed";

/** A stand-in session: the deny path never reaches a write. */
const SESSION = {} as ClientSession;

/** The shape of a thrown `AppError` these specs inspect. */
interface AppErrorLike {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Await a call expected to be denied and return the thrown value.
 *
 * @param promise - The call under test.
 * @returns The thrown value, typed to the fields a contract assertion reads.
 */
async function denialError(promise: Promise<unknown>): Promise<AppErrorLike> {
  try {
    await promise;
  } catch (error) {
    return error as AppErrorLike;
  }
  throw new Error("expected the entitlement call to be denied, but it resolved");
}

/** Seed a fake database with one plan, one subscription and one counter. */
function seed(input: {
  readonly entitlements: Record<string, ReturnType<typeof makeEntitlement>>;
  readonly planKey?: string;
  readonly subscription?: Partial<Parameters<typeof makeSubscription>[0]>;
  readonly used?: number;
}): FakeMongo {
  const planKey = input.planKey ?? "professional";
  const fake = makeFakeMongo();
  fake.seed("plans", [makePlan({ key: planKey, entitlements: input.entitlements })]);
  fake.seed("subscriptions", [
    { ...makeSubscription({ tenantId: TENANT, activePlanKey: planKey, ...input.subscription }) },
  ]);
  fake.seed("usageCounters", [
    { ...makeUsageCounter({ tenantId: TENANT, entitlementKey: KEY, value: input.used ?? 0 }) },
  ]);
  return fake;
}

/**
 * An emitter that always rejects, recording how many times it was attempted.
 *
 * @returns The rejecting emitter and a mutable counter of its attempts.
 */
function rejectingEmitter(): {
  readonly emit: EntitlementEventEmitter;
  readonly attempts: number[];
} {
  const attempts: number[] = [];
  const emit: EntitlementEventEmitter = () => {
    attempts.push(attempts.length + 1);
    return Promise.reject(new Error(EMIT_FAILURE));
  };
  return { emit, attempts };
}

/** The consume seams: the recording fake `Db`, a fixed clock and a rejecting emit. */
function consumeSeams(
  fake: FakeMongo,
  emit: EntitlementEventEmitter
): {
  readonly db: FakeMongo["db"];
  readonly clock: ReturnType<typeof fixedClock>;
  readonly emit: EntitlementEventEmitter;
} {
  return { db: fake.db, clock: fixedClock(NOW), emit };
}

describe("consumeEntitlement — a denial survives a failing outbox emit", () => {
  let previousLogger: Logger;
  let sink: MemoryTransport;

  beforeEach(() => {
    previousLogger = getLogger();
    sink = memoryTransport();
    setLogger(
      createLogger({
        level: "debug",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "test-sha",
      })
    );
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  it("F2: still throws 403 plan_limit_exceeded when the emit rejects", async () => {
    const fake = seed({ entitlements: { [KEY]: makeEntitlement({ limit: 1 }) }, used: 1 });
    const { emit } = rejectingEmitter();

    const error = await denialError(
      consumeEntitlement(SESSION, TENANT, KEY, 1, {}, consumeSeams(fake, emit))
    );

    expect(
      isAppError(error),
      "the denial must throw its AppError even when the outbox emit rejects (not the emit error)"
    ).toBe(true);
    expect(error.code).toBe("plan_limit_exceeded");
    expect(error.status).toBe(403);
    // The emit failure must never be the thrown error.
    expect(error.message).not.toBe(EMIT_FAILURE);
    expect(error.details).toMatchObject({
      entitlementKey: KEY,
      reason: "plan_limit",
      upgradePath: "/api/v1/tenants/current/billing/upgrade",
    });
  });

  it("F2: still throws 402 payment_required when the emit rejects", async () => {
    const fake = seed({
      entitlements: { [KEY]: makeEntitlement({ limit: 1 }) },
      planKey: "free",
      used: 1,
      subscription: {
        status: "downgraded",
        activePlanKey: "free",
        subscribedPlanKey: "professional",
        pendingDueMinor: 49_900,
        currency: "INR",
        gracePeriodEndsAt: new Date("2026-09-20T10:00:00.000Z"),
      },
    });
    const { emit } = rejectingEmitter();

    const error = await denialError(
      consumeEntitlement(SESSION, TENANT, KEY, 1, {}, consumeSeams(fake, emit))
    );

    expect(
      isAppError(error),
      "the 402 denial must throw its AppError even when the outbox emit rejects"
    ).toBe(true);
    expect(error.code).toBe("payment_required");
    expect(error.status).toBe(402);
    expect(error.message).not.toBe(EMIT_FAILURE);
    expect(error.details).toMatchObject({ entitlementKey: KEY, reason: "payment_downgrade" });
  });

  it("F2: still throws 403 feature_not_available when the emit rejects", async () => {
    const fake = seed({
      entitlements: {
        [FEATURE_KEY]: makeEntitlement({
          limit: null,
          resetPeriod: "none",
          scope: "event",
          enforcement: "feature",
          enabled: false,
        }),
      },
    });
    const { emit } = rejectingEmitter();

    const error = await denialError(
      consumeEntitlement(SESSION, TENANT, FEATURE_KEY, 1, {}, consumeSeams(fake, emit))
    );

    expect(
      isAppError(error),
      "the feature denial must throw its AppError even when the outbox emit rejects"
    ).toBe(true);
    expect(error.code).toBe("feature_not_available");
    expect(error.status).toBe(403);
    expect(error.message).not.toBe(EMIT_FAILURE);
    expect(error.details).toMatchObject({ entitlementKey: FEATURE_KEY });
  });

  it("F2: records the emit failure at warn level instead of rethrowing it", async () => {
    const fake = seed({ entitlements: { [KEY]: makeEntitlement({ limit: 1 }) }, used: 1 });
    const { emit } = rejectingEmitter();

    const error = await denialError(
      consumeEntitlement(SESSION, TENANT, KEY, 1, {}, consumeSeams(fake, emit))
    );

    expect(error.code, "the denial must still win over the failed emit").toBe(
      "plan_limit_exceeded"
    );

    // The lost `usage.action.blocked` emit is observable, but as a log line —
    // never as a replacement for the denial.
    const failure = sink.entries.find((entry) => entry.event === "entitlement.denied.emit_failed");
    expect(failure, "a failed outbox emit must be recorded, not swallowed silently").toBeDefined();
    expect(failure?.level).toBe("warn");
    expect(failure?.tenantId).toBe(TENANT);
    expect(failure?.entitlementKey).toBe(KEY);
  });

  it("F2: still records the denial and attempts the blocked emit exactly once", async () => {
    const fake = seed({ entitlements: { [KEY]: makeEntitlement({ limit: 1 }) }, used: 1 });
    const { emit, attempts } = rejectingEmitter();

    const error = await denialError(
      consumeEntitlement(SESSION, TENANT, KEY, 1, {}, consumeSeams(fake, emit))
    );

    expect(error.code, "the denial must still win over the failed emit").toBe(
      "plan_limit_exceeded"
    );
    expect(attempts).toHaveLength(1);

    const denied = sink.entries.find((entry) => entry.event === "entitlement.denied");
    expect(denied, "the denial itself must still be recorded").toBeDefined();
    expect(denied?.level).toBe("info");
    expect(denied?.tenantId).toBe(TENANT);
  });
});
