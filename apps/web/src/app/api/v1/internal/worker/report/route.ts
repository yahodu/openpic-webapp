import type { Document, ObjectId } from "mongodb";
import { z } from "zod";

import { internalRouteAuth } from "@/server/auth/internal-hmac";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { withTransaction } from "@/server/db/transaction";
import { defineRoute } from "@/server/http/define-route";
import { reduceReportItem } from "@/server/internal/worker-report";
import { getLogger } from "@/server/logging";
import { crossTenantReads, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST /api/v1/internal/worker/report` — the worker's work-item verdicts
 * (OP-135, contract §10.3.1, §10.3.2, §10.3.3, §6.4; schema §15.3, §18.2;
 * ADR-0829 §4, ADR-0835 §3).
 *
 * Three properties are load-bearing here:
 *
 *   - **The lease decides at write time.** The reporter owns an item only while
 *     the stored `processing.workerId` is its own and `processing.status` is
 *     live; anything else is counted `leaseLost` and **nothing is written** —
 *     writing results after losing a lease is how duplicate faces appear
 *     (§10.3.1). The predicate rides the write filter, not just the read, so a
 *     lease that changed between the two cannot be applied (ADR-0835 §3).
 *   - **The selfie arm is what makes a late result visible.** A confirmation
 *     that ran before the worker leaves the profile `processing` and publishes
 *     nothing, so only this route can write `status: "ready"`, `matchCount` and
 *     `lastMatchRunAt` — the run's **own** start instant, never the report
 *     instant (§10.3.3's watermark rule). The selfie row and the profile row are
 *     one transaction, so a failed profile write leaves the row `processing`
 *     rather than half-applied (ADR-0835 §3).
 *   - **A withdrawn profile's late result is discarded.** A withdrawal deletes
 *     the selfie rows and their matches (§6.2), so a report that lands
 *     afterwards must not re-create them.
 */

const ROUTE = "/api/v1/internal/worker/report";

/** §10.3.2's batch cap, the same one `/internal/domain-events` applies. */
const MAX_BATCH = 100;

/** The worker's failure descriptor (§10.3.3). */
const reportErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
});

/** One `event_images` item's verdict (§10.3.2). */
const eventImageItemSchema = z.object({
  kind: z.literal("event_image"),
  id: z.string().min(1),
  outcome: z.enum(["done", "failed", "skipped"]),
  faceCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  modelKeys: z.record(z.string(), z.string()).optional(),
  error: reportErrorSchema.optional(),
});

/** One `selfies` item's verdict, plus the facts §6.4 projects (§10.3.2). */
const selfieItemSchema = z.object({
  kind: z.literal("selfie"),
  id: z.string().min(1),
  outcome: z.enum(["done", "failed", "skipped"]),
  quality: z
    .object({ faceCount: z.number().int().nonnegative(), accepted: z.boolean() })
    .optional(),
  liveness: z.object({ passed: z.boolean(), score: z.number() }).optional(),
  matchesCreated: z.number().int().nonnegative().optional(),
  matchRunStartedAt: z.iso.datetime().optional(),
  error: reportErrorSchema.optional(),
});

const reportItemSchema = z.discriminatedUnion("kind", [eventImageItemSchema, selfieItemSchema]);

/** The report body: one lease per worker process, so `workerId` is top-level. */
const reportBodySchema = z.object({
  workerId: z.string().min(1),
  items: z.array(reportItemSchema).max(MAX_BATCH),
});

/** One discarded item: its position, its id and the stable reason. */
const rejectedItemSchema = z.object({
  index: z.number().int(),
  id: z.string(),
  reason: z.string(),
});

/** The §10.3.2 answer. */
const reportResponseSchema = z.object({
  applied: z.number().int(),
  leaseLost: z.number().int(),
  rejected: z.array(rejectedItemSchema),
});

/** A stored attendee profile, as the withdrawn and superseded guards read it (§15.3). */
interface ProfileStatusRow {
  readonly status?: string;
  readonly activeSelfieId?: ObjectId | null;
}

export const POST = defineRoute<
  z.infer<typeof reportBodySchema>,
  z.infer<typeof reportResponseSchema>
>({
  route: ROUTE,
  body: reportBodySchema,
  response: reportResponseSchema,
  auth: internalRouteAuth,
  handler: async (ctx) => {
    const { workerId, items } = ctx.body;
    const db = getDb();
    const now = systemClock.now();
    const settings = await getPlatformSettings({ db });
    const rejected: z.infer<typeof rejectedItemSchema>[] = [];
    let applied = 0;
    let leaseLost = 0;

    /** Count and report a lease this reporter no longer holds. */
    const loseLease = (kind: string, id: string): void => {
      leaseLost += 1;
      getLogger().warn("worker.lease_lost", {
        event: "worker.lease_lost",
        kind,
        id,
        workerId,
      });
    };

    for (const [index, item] of items.entries()) {
      const row = await crossTenantReads.findWorkItemById(item.kind, item.id, db);
      const lease = row?.processing;
      // The read decides which arm runs; the write re-checks the lease, because
      // the row may have changed since this read.
      if (row === null || lease?.status !== "processing" || lease.workerId !== workerId) {
        if (row === null) {
          rejected.push({ index, id: item.id, reason: "unknown_item" });
          getLogger().error("worker.report_rejected", {
            event: "worker.report_rejected",
            id: item.id,
            reason: "unknown_item",
          });
        } else {
          loseLease(item.kind, item.id);
        }
        continue;
      }

      const tenant = tenantRepo(row.tenantId, db);
      // §6.4: the profile's live count and watermark belong to the selfie it
      // points at, so a late report for a superseded row must not move them.
      let supersededSelfie = false;
      if (item.kind === "selfie") {
        const profile = (await tenant
          .collection(COLLECTIONS.attendeeEventProfiles)
          .findOne(
            { _id: row.profileId },
            { projection: { status: 1, activeSelfieId: 1 } }
          )) as ProfileStatusRow | null;
        if (profile?.status === "withdrawn") {
          rejected.push({ index, id: item.id, reason: "profile_withdrawn" });
          getLogger().error("worker.report_rejected", {
            event: "worker.report_rejected",
            id: item.id,
            reason: "profile_withdrawn",
          });
          continue;
        }
        supersededSelfie =
          profile?.activeSelfieId != null && !profile.activeSelfieId.equals(row._id);
      }

      const faceCount = item.kind === "event_image" ? item.faceCount : item.quality?.faceCount;
      const decision = reduceReportItem({
        kind: item.kind,
        outcome: item.outcome,
        ...(faceCount === undefined ? {} : { faceCount }),
        ...(item.error === undefined ? {} : { error: item.error }),
        attempts: lease.attempts ?? 0,
        maxAttempts: lease.maxAttempts ?? settings.pipeline.maxAttempts,
        now,
      });
      const processing: Document = {
        "processing.status": decision.status,
        "processing.finishedAt": decision.finishedAt,
        "processing.lastError": decision.lastError,
      };
      // The lease is a fact of the row this write addresses: a reporter whose
      // lease was taken over between the read and the write matches nothing.
      const leaseFilter = {
        _id: row._id,
        "processing.workerId": workerId,
        "processing.status": "processing",
      };

      if (item.kind === "event_image") {
        const written = await tenant.collection(COLLECTIONS.eventImages).updateOne(leaseFilter, {
          $set: {
            ...processing,
            "processing.durationMs": item.durationMs ?? null,
            ...(item.modelKeys === undefined ? {} : { "processing.modelKeys": item.modelKeys }),
          },
        });
        if (written.matchedCount === 0) {
          loseLease(item.kind, item.id);
          continue;
        }
      } else {
        const kept = await withTransaction(async (session) => {
          const written = await tenant.collection(COLLECTIONS.selfies).updateOne(
            leaseFilter,
            {
              $set: {
                ...processing,
                ...(item.quality === undefined
                  ? {}
                  : {
                      "quality.faceCount": item.quality.faceCount,
                      "quality.accepted": item.quality.accepted,
                    }),
                ...(item.liveness === undefined
                  ? {}
                  : {
                      "liveness.passed": item.liveness.passed,
                      "liveness.score": item.liveness.score,
                    }),
              },
            },
            { session }
          );
          if (written.matchedCount === 0) {
            return false;
          }
          // The profile projection §6.4 polls: `ready` only on a success, and
          // the watermark is the run's own start instant (§10.3.3).
          if (decision.status !== "skipped") {
            if (supersededSelfie) {
              getLogger().warn("worker.report_discarded", {
                event: "worker.report_discarded",
                kind: item.kind,
                id: item.id,
                workerId,
                reason: "superseded_selfie",
              });
            } else {
              await tenant.collection(COLLECTIONS.attendeeEventProfiles).updateOne(
                { _id: row.profileId },
                {
                  $set:
                    decision.status === "done"
                      ? {
                          status: "ready",
                          matchCount: item.matchesCreated ?? 0,
                          lastMatchRunAt:
                            item.matchRunStartedAt === undefined
                              ? null
                              : new Date(item.matchRunStartedAt),
                          updatedAt: now,
                        }
                      : { status: "failed", updatedAt: now },
                },
                { session }
              );
            }
          }
          return true;
        });
        if (!kept) {
          loseLease(item.kind, item.id);
          continue;
        }
      }

      applied += 1;
    }

    return { body: { applied, leaseLost, rejected } };
  },
});
