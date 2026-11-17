import { ObjectId } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import type { Plan } from "@/server/plans/plans";
import { tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { periodKey } from "@/server/services/entitlements";
import {
  comparePlanTiers,
  computeDowngradeConsequences,
  downgradeRequestSchema,
  downgradeResponseSchema,
  loadPlan,
  unsoldField,
  type DowngradeResponse,
  type EntitlementUsageFact,
} from "@/server/services/subscriptions";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/billing/downgrade` — schedule a move down to
 * a cheaper tier at period end (OP-109, contract §3.3; ADR-0460).
 *
 * Unlike an upgrade, a downgrade is **never immediate**: it writes
 * `scheduledChange = { toPlanKey, effectiveAt: currentPeriodEnd, reason:
 * "self_downgrade" }` and leaves the live plan untouched, because an instant
 * downgrade would strand already-created content above the new limits — the
 * thing §10 forbids. The cron sweep (OP-111) applies it at period end.
 *
 * The consequences are computed from the tenant's **usage** against the target
 * plan's limits and served in the refusal so the caller can acknowledge them
 * (`{ targetPlanKey, acknowledgeConsequences: true }`); every consequence is
 * non-destructive (§3.3's hard invariant), so this is a warning, never a
 * deletion.
 */

/** The `statusHistory`-independent reason a self-serve downgrade records (§3.3). */
const SELF_DOWNGRADE_REASON = "self_downgrade";

/** The stored live-row fields a downgrade reads (schema §14.3). */
const liveSubscriptionSchema = z.object({
  _id: z.instanceof(ObjectId),
  activePlanKey: z.string().default("free"),
  currentPeriodEnd: z.date().optional(),
});

/** A stored `usageCounters` row (§14.2). */
const usageCounterSchema = z.object({ value: z.number() });

/**
 * Resolve the tenant's usage facts for an entitlement key at its own cadence.
 *
 * §14.2 advances a counter only for a `tenant`-scoped key, which is why the
 * route reads one only for those keys and passes `0` when no row exists yet:
 * the walk then treats an untouched key as headroom rather than as a shrink.
 *
 * @param db - The database handle.
 * @param tenantId - The string hex workspace id.
 * @param plan - The current plan the keys are taken from.
 * @param now - The instant the period keys are derived at.
 * @returns One fact per tenant-scoped, non-feature key of `plan`.
 */
async function resolveUsageFacts(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  plan: Plan,
  now: Date
): Promise<readonly EntitlementUsageFact[]> {
  const counters = tenantRepo(tenantId, db).collection(COLLECTIONS.usageCounters);
  const facts: EntitlementUsageFact[] = [];

  for (const [entitlementKey, spec] of Object.entries(plan.entitlements)) {
    if (spec.scope !== "tenant" || spec.enforcement === "feature") {
      continue;
    }
    const row = await counters.findOne({
      entitlementKey,
      periodKey: periodKey(spec.resetPeriod, now),
    });
    facts.push({
      entitlementKey,
      used: row === null ? 0 : usageCounterSchema.parse(row).value,
    });
  }

  return facts;
}

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/billing/downgrade",
  body: downgradeRequestSchema,
  response: downgradeResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    // §3.3 makes every billing mutation owner-only.
    if (scope.role !== "owner") {
      throw appError("forbidden");
    }

    const db = getDb();
    const now = systemClock.now();
    const tenantId = scope.tenantId.toHexString();
    const { targetPlanKey, acknowledgeConsequences } = ctx.body;

    const subscriptions = tenantRepo(tenantId, db).collection(COLLECTIONS.subscriptions);
    const stored = await subscriptions.findOne({ cancelledAt: null }, { sort: { updatedAt: -1 } });
    if (stored === null) {
      throw appError("conflict", { details: { reason: "no_live_subscription" } });
    }
    const current = liveSubscriptionSchema.parse(stored);

    const targetPlan = await loadPlan(db, targetPlanKey);
    if (!targetPlan?.active) {
      throw appError("validation_failed", {
        details: { fields: [unsoldField("targetPlanKey")] },
      });
    }
    const currentPlan = await loadPlan(db, current.activePlanKey);
    if (currentPlan === null) {
      throw appError("internal_error");
    }

    // §3.3 schedules a downgrade against a strictly lower tier. Anything else
    // (an equal rank included) is refused before any write — the mirror of the
    // upgrade's `not_an_upgrade` — so a higher tier can never be scheduled as a
    // "downgrade" and then applied by the sweep with no charge and no
    // re-authorization. The `upgradeUrl` names the endpoint that can serve it.
    if (comparePlanTiers(currentPlan.tierRank, targetPlan.tierRank) !== "downgrade") {
      throw appError("not_a_downgrade", {
        details: {
          currentTierRank: currentPlan.tierRank,
          targetTierRank: targetPlan.tierRank,
          upgradeUrl: `/api/v1/tenants/${tenantId}/billing/upgrade`,
        },
      });
    }

    const usage = await resolveUsageFacts(db, tenantId, currentPlan, now);
    const consequences = computeDowngradeConsequences({ currentPlan, targetPlan, usage });

    // §3.3: the caller must acknowledge what the downgrade will constrain
    // before it is scheduled — the refusal carries the consequences.
    if (acknowledgeConsequences !== true) {
      throw appError("acknowledgement_required", { details: { consequences } });
    }

    const effectiveAt = current.currentPeriodEnd ?? now;
    await subscriptions.updateOne(
      { _id: current._id },
      {
        $set: {
          scheduledChange: {
            toPlanKey: targetPlan.key,
            effectiveAt,
            reason: SELF_DOWNGRADE_REASON,
          },
          updatedAt: now,
        },
      }
    );

    getLogger().info("billing plan downgrade scheduled", {
      event: "billing.plan.downgrade_scheduled",
      tenantId,
      fromPlanKey: currentPlan.key,
      toPlanKey: targetPlan.key,
      effectiveAt: effectiveAt.toISOString(),
    });

    return {
      body: {
        scheduledChange: {
          toPlanKey: targetPlan.key,
          effectiveAt: effectiveAt.toISOString(),
        },
      } satisfies DowngradeResponse,
    };
  },
});
