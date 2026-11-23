import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { dsrSlaCheckJob } from "@/server/jobs/dsr-sla-check";
import { fixedClock } from "@/server/runtime/clock";

import { ACTIVITY_AT, makeDsrRow, makeTenantRow } from "../factories/rollup-jobs";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `dsr-sla-check` (OP-139 I5, contract §10.2, §8.1;
 * schema §20.3; ADR-0918, ADR-0898).
 *
 * The user story: *as an operator I want to be warned before a statutory
 * deadline runs out, not after it has.* OP-138 stamps every data-subject request
 * with `slaDueAt` (contract §8.1, `platformSettings.compliance.slaDays`); this
 * job is the only thing that reads that field, so an unwarned request becomes a
 * missed statutory deadline with no second chance.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/jobs/dsr-sla-check` exports `dsrSlaCheckJob: CronJob`
 * (`defineCronJob({ name: "dsr-sla-check", … })`), registered daily in
 * `apps/web/vercel.json`.
 *
 * - **Open requests only.** A request is at risk when its `status` is neither
 *   `completed` nor `rejected`; a closed request is never announced, however
 *   close its deadline.
 * - **The 48-hour window.** A request whose `slaDueAt` falls at or before
 *   `now + 48 h` is at risk (`slaDueAt <= run instant + 48 × 3 600 000 ms`).
 *   The boundary is inclusive: the contract's "within 48 h" is the 48-hour
 *   mark itself, and the spec pins both sides of it — exactly 48 h warns, one
 *   millisecond later does not. The card's own fixture (47 h) is the interior
 *   arm.
 * - **One event per request per day.** Each at-risk request emits one
 *   `admin.dsr.sla_risk` domain event per Asia/Kolkata day (the day is the
 *   `Clock` instant's bucket), so a same-day rerun is silent and the next day
 *   warns again while the request is still at risk. The dedupe key therefore
 *   carries both the request id and the day key.
 * - **Tenant address.** The event is emitted under the first tenant in the
 *   request's `scope.tenantIds` (a request that resolved no tenant has no
 *   tenant to announce it under — the same rule `POST /me/data-requests`
 *   applies to its acknowledgement).
 * - **Payload.** Exactly `{ requestId, requestType, slaDueAt }` — the id, the
 *   enum and the deadline. No subject, no note text, no contact data.
 *
 * ## Assumptions (ADR-0918 §Assumptions)
 *
 * - A13 — the run's day key comes from `dateKeyInTimeZone(clock.now(),
 *   "Asia/Kolkata")`. The spec is agnostic to whether that is "today" or "the day
 *   that closed" (both cross a day boundary exactly once per 24 h), so the pin
 *   holds for either choice.
 * - A14 — a request already past its deadline is not pinned here (the card's
 *   fixture is 47 h *before* it), which keeps "warn ahead" and "breach
 *   escalation" separable; a breach bell is a different story.
 * - A15 — the 48-hour boundary is inclusive, and the negative arm is
 *   `48 h + 1 ms`. Both directions are pinned in one case so a job that
 *   widens or narrows the horizon by a day cannot pass.
 */

let app: TestApp;

/** The instant each at-risk request falls due, 47 hours after {@link ACTIVITY_AT}. */
const DUE_IN_47_HOURS = new Date(ACTIVITY_AT.getTime() + 47 * 3_600_000);

/** The instant a request 60 hours out falls due. */
const DUE_IN_60_HOURS = new Date(ACTIVITY_AT.getTime() + 60 * 3_600_000);

/** Exactly 48 hours out — the inclusive edge of the warning window. */
const DUE_IN_48_HOURS = new Date(ACTIVITY_AT.getTime() + 48 * 3_600_000);

/** One millisecond beyond the window. */
const DUE_JUST_OUTSIDE = new Date(DUE_IN_48_HOURS.getTime() + 1);

/** The next day's run instant, 24 hours after {@link ACTIVITY_AT}. */
const NEXT_DAY = new Date(ACTIVITY_AT.getTime() + 24 * 3_600_000);

/** Run the SLA check at one fixed instant. */
function runCheck(at: Date): ReturnType<typeof dsrSlaCheckJob.run> {
  return dsrSlaCheckJob.run({
    requestedLimit: null,
    clock: fixedClock(at),
    logger: recordingLogger(),
  });
}

/** Every `admin.dsr.sla_risk` outbox row, oldest first. */
async function riskEvents(): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: "admin.dsr.sla_risk" })
    .sort({ _id: 1 })
    .toArray();
}

/** Seed one live tenant and return its stored id and its hex form. */
async function seedLiveTenant(slug: string): Promise<{
  readonly tenantObjectId: ObjectId;
  readonly tenantId: string;
}> {
  const tenantObjectId = new ObjectId();
  await app.db
    .collection(COLLECTIONS.tenants)
    .insertOne(makeTenantRow({ _id: tenantObjectId, slug }));
  return { tenantObjectId, tenantId: tenantObjectId.toHexString() };
}

beforeAll(async () => {
  app = await startTestApp({ prefix: "op139-dsr-sla" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [COLLECTIONS.tenants, COLLECTIONS.dataSubjectRequests, COLLECTIONS.domainEvents].map((name) =>
      app.db.collection(name).deleteMany({})
    )
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("dsr-sla-check I5: the 48-hour warning", () => {
  it("I5: a request 47 hours from its SLA emits once, stays silent on a same-day rerun, and speaks again the next day", async () => {
    // ── Arrange: one open request due in 47 hours ──
    const live = await seedLiveTenant("op139-dsr-risk");
    const requestId = new ObjectId();
    await app.db.collection(COLLECTIONS.dataSubjectRequests).insertOne(
      makeDsrRow({
        _id: requestId,
        tenantId: live.tenantId,
        status: "received",
        slaDueAt: DUE_IN_47_HOURS,
        requestType: "access",
      })
    );

    // ── Act: the daily run ──
    await runCheck(ACTIVITY_AT);

    // ── Assert: one warning, addressed to the request's tenant, with the
    // three-field payload ──
    const first = await riskEvents();
    expect(first).toHaveLength(1);
    expect(first[0]?.tenantId).toBe(live.tenantId);
    expect(first[0]?.payload).toMatchObject({
      requestId: requestId.toHexString(),
      requestType: "access",
      slaDueAt: DUE_IN_47_HOURS.toISOString(),
    });
    const payload = first[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["requestId", "requestType", "slaDueAt"]);

    // ── Act: an operator reruns the check the same day ──
    await runCheck(ACTIVITY_AT);

    // ── Assert: the request is still at risk, but the day has already spoken ──
    expect(await riskEvents()).toHaveLength(1);

    // ── Act: the next day's run, with 23 hours left ──
    await runCheck(NEXT_DAY);

    // ── Assert: one more warning, for the new day ──
    expect(await riskEvents()).toHaveLength(2);
  });

  it("I5: the 48-hour edge itself warns, and one millisecond beyond it does not", async () => {
    // ── Arrange: two open requests, one on the edge and one past it ──
    const live = await seedLiveTenant("op139-dsr-edge");
    const onTheEdge = new ObjectId();
    await app.db.collection(COLLECTIONS.dataSubjectRequests).insertMany([
      makeDsrRow({
        _id: onTheEdge,
        tenantId: live.tenantId,
        status: "received",
        slaDueAt: DUE_IN_48_HOURS,
      }),
      makeDsrRow({ tenantId: live.tenantId, status: "received", slaDueAt: DUE_JUST_OUTSIDE }),
    ]);

    // ── Act ──
    await runCheck(ACTIVITY_AT);

    // ── Assert: the edge warns, the extra millisecond does not ──
    const events = await riskEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ requestId: onTheEdge.toHexString() });
  });

  it("I5: a request outside the window, and a closed request inside it, are not warned", async () => {
    // ── Arrange: an at-risk control request, plus three that must stay silent ──
    const live = await seedLiveTenant("op139-dsr-quiet");
    const control = new ObjectId();
    await app.db.collection(COLLECTIONS.dataSubjectRequests).insertMany([
      // The positive control: inside the window and open, so this case cannot
      // pass by warning about nothing at all.
      makeDsrRow({
        _id: control,
        tenantId: live.tenantId,
        status: "received",
        slaDueAt: DUE_IN_47_HOURS,
      }),
      // Due in 60 hours — outside the 48-hour window.
      makeDsrRow({ tenantId: live.tenantId, status: "received", slaDueAt: DUE_IN_60_HOURS }),
      // Inside the window but already answered.
      makeDsrRow({ tenantId: live.tenantId, status: "completed", slaDueAt: DUE_IN_47_HOURS }),
      // Inside the window but refused.
      makeDsrRow({ tenantId: live.tenantId, status: "rejected", slaDueAt: DUE_IN_47_HOURS }),
    ]);

    // ── Act ──
    await runCheck(ACTIVITY_AT);

    // ── Assert: the control alone is announced ──
    const events = await riskEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ requestId: control.toHexString() });
  });

  it("I5: an in-progress or verifying request inside the window is warned", async () => {
    // ── Arrange: an operator already working the request, and one still being
    // verified — both are open (schema §20.3's status enum) ──
    const live = await seedLiveTenant("op139-dsr-progress");
    const inProgress = new ObjectId();
    const verifying = new ObjectId();
    await app.db.collection(COLLECTIONS.dataSubjectRequests).insertMany([
      makeDsrRow({
        _id: inProgress,
        tenantId: live.tenantId,
        status: "in_progress",
        slaDueAt: DUE_IN_47_HOURS,
        requestType: "erasure",
      }),
      makeDsrRow({
        _id: verifying,
        tenantId: live.tenantId,
        status: "verifying",
        slaDueAt: DUE_IN_47_HOURS,
        requestType: "portability",
      }),
    ]);

    // ── Act ──
    await runCheck(ACTIVITY_AT);

    // ── Assert: both open states are announced, one event each ──
    const events = await riskEvents();
    expect(events).toHaveLength(2);
    expect(
      events.map((event) => (event.payload as Record<string, unknown>).requestId).sort()
    ).toEqual([inProgress.toHexString(), verifying.toHexString()].sort());
  });
});

/**
 * `dsr-sla-check` F3 — the per-run budget must page through the queue
 * (OP-139 F3 of the GREEN review; ADR-0925).
 *
 * The run reads its candidates with `{ sort: { slaDueAt: 1 }, limit }` and no
 * cursor, so when the at-risk population is larger than the budget every run
 * re-reads the same earliest-deadline prefix, the outbox `dedupeKey` swallows
 * the repeats (`affected: 0`) and the tail is never warned — while `hasMore`
 * stays `true`. A statutory-deadline warning that silently never fires is the
 * failure this job exists to prevent, so these cases pin that the queue
 * advances: a request already warned for the current IST day must not consume
 * the next run's budget, and an un-warned request must take its place.
 *
 * The contract these cases expect of the implementation: the day's exclusion
 * window moves at IST midnight, so the next day's run sees an empty exclusion
 * and an already-warned, still-at-risk request speaks again (the shipped
 * daily-repeat property).
 */

/** The instant the earliest of the three paging fixtures falls due, 40 hours out. */
const DUE_IN_40_HOURS = new Date(ACTIVITY_AT.getTime() + 40 * 3_600_000);

/** The instant the middle of the three paging fixtures falls due, 44 hours out. */
const DUE_IN_44_HOURS = new Date(ACTIVITY_AT.getTime() + 44 * 3_600_000);

/** Run the SLA check at one fixed instant with an explicit per-run budget. */
function runCheckWithLimit(
  at: Date,
  requestedLimit: string
): ReturnType<typeof dsrSlaCheckJob.run> {
  return dsrSlaCheckJob.run({
    requestedLimit,
    clock: fixedClock(at),
    logger: recordingLogger(),
  });
}

/** The `payload.requestId` of every `admin.dsr.sla_risk` row, oldest first. */
async function warnedRequestIds(): Promise<string[]> {
  const events = await riskEvents();
  return events.map((event) => (event.payload as Record<string, unknown>).requestId as string);
}

/** Seed three open requests inside the 48-hour window, earliest deadline first. */
async function seedThreeAtRiskRequests(tenantId: string): Promise<{
  readonly dueFirst: ObjectId;
  readonly dueSecond: ObjectId;
  readonly dueThird: ObjectId;
}> {
  const dueFirst = new ObjectId();
  const dueSecond = new ObjectId();
  const dueThird = new ObjectId();
  await app.db.collection(COLLECTIONS.dataSubjectRequests).insertMany([
    makeDsrRow({
      _id: dueFirst,
      tenantId,
      status: "received",
      slaDueAt: DUE_IN_40_HOURS,
      requestType: "access",
    }),
    makeDsrRow({
      _id: dueSecond,
      tenantId,
      status: "in_progress",
      slaDueAt: DUE_IN_44_HOURS,
      requestType: "erasure",
    }),
    makeDsrRow({
      _id: dueThird,
      tenantId,
      status: "verifying",
      slaDueAt: DUE_IN_47_HOURS,
      requestType: "portability",
    }),
  ]);
  return { dueFirst, dueSecond, dueThird };
}

describe("dsr-sla-check F3: the run budget pages past the requests already warned today", () => {
  it("F3: with a budget of one, three same-day runs warn each of three at-risk requests exactly once, then the next day warns the earliest again", async () => {
    // ── Arrange: three open requests inside the window, distinct deadlines ──
    const live = await seedLiveTenant("op139-dsr-paging-one");
    const { dueFirst, dueSecond, dueThird } = await seedThreeAtRiskRequests(live.tenantId);

    // ── Act: the first run, allowed to announce one request ──
    await runCheckWithLimit(ACTIVITY_AT, "1");

    // ── Assert: the budget is spent on the earliest deadline ──
    expect(await warnedRequestIds()).toEqual([dueFirst.toHexString()]);

    // ── Act: the second run of the same day, same budget ──
    await runCheckWithLimit(ACTIVITY_AT, "1");

    // ── Assert: the budget slid past the request already warned today ──
    expect((await warnedRequestIds()).sort()).toEqual(
      [dueFirst.toHexString(), dueSecond.toHexString()].sort()
    );

    // ── Act: the third run of the same day ──
    await runCheckWithLimit(ACTIVITY_AT, "1");

    // ── Assert: the set of warned requests, not a count of three with one id
    // repeated — every request spoke exactly once ──
    expect((await warnedRequestIds()).sort()).toEqual(
      [dueFirst.toHexString(), dueSecond.toHexString(), dueThird.toHexString()].sort()
    );

    // ── Act: the next day's run, same budget ──
    await runCheckWithLimit(NEXT_DAY, "1");

    // ── Assert: the day boundary emptied the exclusion, so an already-warned
    // and still-at-risk request speaks again ──
    const nextDay = await warnedRequestIds();
    expect(nextDay).toHaveLength(4);
    expect(nextDay.slice(3)).toEqual([dueFirst.toHexString()]);
  });

  it("F3: with a budget of two, the first run warns exactly two and the second run warns the third, with no same-day repeat", async () => {
    // ── Arrange: three open requests inside the window, distinct deadlines ──
    const live = await seedLiveTenant("op139-dsr-paging-two");
    const { dueFirst, dueSecond, dueThird } = await seedThreeAtRiskRequests(live.tenantId);

    // ── Act: the first run, allowed two warnings ──
    await runCheckWithLimit(ACTIVITY_AT, "2");

    // ── Assert: the whole budget is spent on the two earliest deadlines ──
    const firstRun = await warnedRequestIds();
    expect(firstRun.sort()).toEqual([dueFirst.toHexString(), dueSecond.toHexString()].sort());

    // ── Act: the second run of the same day, same budget ──
    await runCheckWithLimit(ACTIVITY_AT, "2");

    // ── Assert: the queue advanced — the third request is the only new
    // warning, so no request of the first run was warned twice ──
    const secondRun = await warnedRequestIds();
    expect(secondRun).toHaveLength(3);
    expect(secondRun.filter((requestId) => !firstRun.includes(requestId))).toEqual([
      dueThird.toHexString(),
    ]);
  });
});

/**
 * Run the SLA check with an explicit per-run budget on a freshly evaluated
 * module — the way a serverless invocation sees the job: a cold module registry
 * and nothing carried over from the previous run.
 *
 * `vi.resetModules()` drops the registry, so the `import` below re-executes the
 * job's module graph. Only the database client survives it (it lives on a
 * `globalThis` slot), which is what keeps the run pointed at the test database.
 *
 * @param at - The fixed instant the run's clock reports.
 * @param requestedLimit - The per-run budget, as the cron route passes it.
 */
async function runCheckOnAColdModule(at: Date, requestedLimit: string): Promise<void> {
  vi.resetModules();
  const coldModule = await import("@/server/jobs/dsr-sla-check");
  await coldModule.dsrSlaCheckJob.run({
    requestedLimit,
    clock: fixedClock(at),
    logger: recordingLogger(),
  });
}

/**
 * `dsr-sla-check` F1 of the F3 pin review — the paging exclusion must survive a
 * cold start (OP-139; ADR-0927).
 *
 * Each cron invocation is a fresh serverless function (`apps/web/vercel.json` →
 * `/api/v1/internal/cron/dsr-sla-check`, `45 2 * * *`), so a run cannot remember
 * what the previous run warned: the day's exclusion has to be read back from the
 * stored `admin.dsr.sla_risk` rows. The F3 cases above drive one module instance
 * for a whole case (`dsrSlaCheckJob` is imported once at the top of this file),
 * so an implementation that keeps the warned ids in module scope passes them
 * while paging nothing at all in production — the defect F3 exists to prevent.
 *
 * This case drops the module registry before every run and imports the job
 * again, so only a persisted exclusion lets the budget advance onto the tail.
 * The Mongo client is a `globalThis` slot (`@/server/db/mongo`), not module
 * state, so the re-imported module still reads the one test database.
 */
describe("dsr-sla-check cold start: the paging exclusion is persisted, not in-process", () => {
  it("F1: three cold-start runs with a budget of one still warn each of the three at-risk requests exactly once", async () => {
    // ── Arrange: three open requests inside the window, distinct deadlines ──
    const live = await seedLiveTenant("op139-dsr-cold-start");
    const { dueFirst, dueSecond, dueThird } = await seedThreeAtRiskRequests(live.tenantId);

    // ── Act: three runs of the same IST day, each on a freshly evaluated
    // module — nothing may be carried over from the previous invocation ──
    await runCheckOnAColdModule(ACTIVITY_AT, "1");
    await runCheckOnAColdModule(ACTIVITY_AT, "1");
    await runCheckOnAColdModule(ACTIVITY_AT, "1");

    // ── Assert: the budget paged onto all three, so the exclusion was read
    // back from the day's stored events, not from process memory ──
    expect((await warnedRequestIds()).sort()).toEqual(
      [dueFirst.toHexString(), dueSecond.toHexString(), dueThird.toHexString()].sort()
    );
  });
});
