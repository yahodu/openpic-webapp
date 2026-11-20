import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { tenantIsolationAuditJob } from "@/server/jobs/tenant-isolation-audit";
import { fixedClock } from "@/server/runtime/clock";

import {
  ACTIVITY_AT,
  makeEventImageRow,
  makeEventRow,
  makeTenantRow,
} from "../factories/rollup-jobs";
import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import { recordingLogger } from "../helpers/recording-logger";

/**
 * Integration / contract — `tenant-isolation-audit` (OP-139 I3/I4, contract
 * §10.2, §0.4; schema §21 P3; ADR-0918).
 *
 * The user story: *as an operator I want the nightly audit to tell me when a
 * document has escaped its tenant, because a leaked row is the failure mode a
 * tenancy bug has and no request path will report it.* The audit runs out of
 * band, after the fact: it never repairs a row (repair needs a human decision
 * about which side is wrong), it raises `admin.abuse.flagged` instead.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/jobs/tenant-isolation-audit` exports
 * `tenantIsolationAuditJob: CronJob` (`defineCronJob({ name:
 * "tenant-isolation-audit", … })`), registered nightly in
 * `apps/web/vercel.json`.
 *
 * - **Sweep.** Every collection in `TENANT_SCOPED_COLLECTIONS`
 *   (`@/server/db/indexes`) — imported, never re-listed, so a collection that
 *   joins the registry is audited without a second edit.
 * - **Two findings.**
 *   - `unresolved_tenant`: the document's `tenantId` does not resolve to a
 *     `tenants` `_id` (`tenantId` is stored as a hex **string** on
 *     tenant-scoped rows, and the tenant's `_id` is an `ObjectId`, so the
 *     comparison is on the hex form).
 *   - `tenant_mismatch`: the document's `tenantId` disagrees with its parent
 *     event's `tenantId` — the `event_images` / parent `events` pair is the
 *     shipped case.
 * - **One event per finding per day.** Each `(reason, collection)` pair emits at
 *   most one `admin.abuse.flagged` per calendar day (the day is the `Clock`
 *   instant's `Asia/Kolkata` bucket), so a nightly rerun of the same day is
 *   silent and a genuinely new finding the next day speaks again.
 * - **Counts only.** The payload's key set is exactly `collection`, `count` and
 *   `reason`: no ids, no field values, no document contents (the card's "with
 *   counts only"; §0.15 forbids document payloads leaving the boundary).
 *
 * ## Assumptions (ADR-0918 §Assumptions)
 *
 * - A10 — the finding is raised under the document's **own** `tenantId` (for
 *   `unresolved_tenant` that id is not a live tenant; `emitDomainEvent` only
 *   needs a string). A platform-scope alerting address is not in the contract.
 * - A11 — a `tenant_mismatch` row is reported once, under `event_images`, and
 *   is *not* counted again as `unresolved_tenant` when its own `tenantId` does
 *   resolve: the two reasons are exclusive.
 * - A12 — the audit does **not** flag a document whose parent event has been
 *   deleted; there is no parent to disagree with, and that is the retention
 *   lane's business.
 * - A19 — `scanned` is the number of tenant-scoped **documents** the sweep
 *   examined, so the "not flagged" case can prove it looked at the healthy rows
 *   rather than reporting silence without work.
 */

let app: TestApp;

/** Run the audit at one fixed instant with a fresh recording logger. */
function runAudit(at: Date = ACTIVITY_AT): ReturnType<typeof tenantIsolationAuditJob.run> {
  return tenantIsolationAuditJob.run({
    requestedLimit: null,
    clock: fixedClock(at),
    logger: recordingLogger(),
  });
}

/** Every `admin.abuse.flagged` outbox row, oldest first. */
async function auditEvents(): Promise<Record<string, unknown>[]> {
  return app.db
    .collection(COLLECTIONS.domainEvents)
    .find({ eventKey: "admin.abuse.flagged" })
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
  app = await startTestApp({ prefix: "op139-isolation" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await Promise.all(
    [
      COLLECTIONS.tenants,
      COLLECTIONS.events,
      COLLECTIONS.eventImages,
      COLLECTIONS.eventOrganizers,
      COLLECTIONS.usageCounters,
      COLLECTIONS.entitlementGrants,
      COLLECTIONS.subscriptions,
      COLLECTIONS.mediaAssets,
      COLLECTIONS.accessLinks,
      COLLECTIONS.dispatches,
      COLLECTIONS.domainEvents,
    ].map((name) => app.db.collection(name).deleteMany({}))
  );
});

afterAll(async () => {
  await app.cleanup();
});

describe("tenant-isolation-audit I3: a document with an unresolvable tenant", () => {
  it("I3: an orphan tenantId document is flagged once, with counts only", async () => {
    // ── Arrange: one live tenant, plus a usageCounters row under a tenant that
    // does not exist ──
    await seedLiveTenant("op139-orphan-live");
    const orphanTenantId = new ObjectId().toHexString();
    await app.db.collection(COLLECTIONS.usageCounters).insertOne({
      tenantId: orphanTenantId,
      entitlementKey: "storage.bytes",
      periodKey: "lifetime",
      value: 10,
      updatedAt: ACTIVITY_AT,
    });

    // ── Act: the nightly audit ──
    await runAudit();

    // ── Assert: exactly one finding, counts only ──
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe(orphanTenantId);
    expect(events[0]?.payload).toMatchObject({
      reason: "unresolved_tenant",
      collection: "usageCounters",
      count: 1,
    });
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["collection", "count", "reason"]);

    // ── Act: an operator reruns the audit the same day ──
    await runAudit();

    // ── Assert: the same finding is not announced twice ──
    expect(await auditEvents()).toHaveLength(1);
  });

  it("I3: a document whose tenant resolves is not flagged", async () => {
    // ── Arrange: a healthy tenant with its own event and image ──
    const live = await seedLiveTenant("op139-healthy");
    const eventId = new ObjectId();
    await app.db
      .collection(COLLECTIONS.events)
      .insertOne(makeEventRow({ _id: eventId, tenantId: live.tenantId }));
    await app.db
      .collection(COLLECTIONS.eventImages)
      .insertOne(makeEventImageRow({ tenantId: live.tenantId, eventId }));
    await app.db.collection(COLLECTIONS.usageCounters).insertOne({
      tenantId: live.tenantId,
      entitlementKey: "storage.bytes",
      periodKey: "lifetime",
      value: 10,
      updatedAt: ACTIVITY_AT,
    });

    // ── Act ──
    const result = await runAudit();

    // ── Assert: the three healthy rows were examined and none was flagged.
    // The scan count is the control: a job that examines nothing must not
    // satisfy "found nothing". ──
    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(await auditEvents()).toEqual([]);
  });
});

describe("tenant-isolation-audit I4: a document whose tenant disagrees with its parent", () => {
  it("I4: an event image whose tenantId differs from its event's tenantId is flagged", async () => {
    // ── Arrange: two live tenants; an image of B's event filed under A ──
    const alpha = await seedLiveTenant("op139-mismatch-a");
    const beta = await seedLiveTenant("op139-mismatch-b");
    const betaEventId = new ObjectId();
    await app.db
      .collection(COLLECTIONS.events)
      .insertOne(makeEventRow({ _id: betaEventId, tenantId: beta.tenantId }));
    await app.db
      .collection(COLLECTIONS.eventImages)
      .insertOne(makeEventImageRow({ tenantId: alpha.tenantId, eventId: betaEventId }));

    // ── Act ──
    await runAudit();

    // ── Assert: one mismatch finding, and it is not double-reported as an
    // unresolvable tenant (both tenants are live) ──
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      reason: "tenant_mismatch",
      collection: "event_images",
      count: 1,
    });
  });

  it("I4: counts every disagreeing image and never the agreeing ones", async () => {
    // ── Arrange: two mismatched images and one correct image on the same event ──
    const alpha = await seedLiveTenant("op139-mixed-a");
    const beta = await seedLiveTenant("op139-mixed-b");
    const betaEventId = new ObjectId();
    await app.db
      .collection(COLLECTIONS.events)
      .insertOne(makeEventRow({ _id: betaEventId, tenantId: beta.tenantId }));
    await app.db
      .collection(COLLECTIONS.eventImages)
      .insertMany([
        makeEventImageRow({ tenantId: alpha.tenantId, eventId: betaEventId }),
        makeEventImageRow({ tenantId: alpha.tenantId, eventId: betaEventId }),
        makeEventImageRow({ tenantId: beta.tenantId, eventId: betaEventId }),
      ]);

    // ── Act ──
    await runAudit();

    // ── Assert: the count is the number of disagreeing rows, not of rows ──
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      reason: "tenant_mismatch",
      collection: "event_images",
      count: 2,
    });
  });
});
