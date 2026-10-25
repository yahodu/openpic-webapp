import type { Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { planSchema, type Plan, type PlanPrice } from "@/server/plans/plans";
import { platformRepo } from "@/server/repos";

/**
 * The plans-catalogue reads the billing mutations share (OP-107 checkout,
 * OP-109 upgrade; ADR-0421 / ADR-0460).
 *
 * Both routes resolve a **sold** plan and price from the platform-scope
 * catalogue: the plan document, the active price and the vendor plan id that
 * price's `externalRefs` carries. The vendor name is confined to
 * `plans.prices[].externalRefs` (ADR-0001), so the reference a mandate is
 * addressed to has to flow from there — a price with no `kind: "plan"` ref
 * cannot be sold and is refused. Keeping the reads here means the checkout and
 * the upgrade refuse an unsellable plan the same way.
 */

/** The `returnUrl` a sales-assisted refusal points at: a *config* fact, not an env var. */
export const CONTACT_SALES_URL = "/contact-sales";

/**
 * Load one stored plan from the platform-scope catalogue, or `null`.
 *
 * @param db - The database handle.
 * @param planKey - The plan key to resolve.
 * @returns The validated plan, or `null` when the key is unknown.
 */
export async function loadPlan(db: Db, planKey: string): Promise<Plan | null> {
  const row = await platformRepo(db).collection(COLLECTIONS.plans).findOne({ key: planKey });
  return row === null ? null : planSchema.parse(row);
}

/** The sold price and the vendor plan reference it carries. */
export interface SoldPrice {
  /** The active price. */
  readonly price: PlanPrice;
  /** The vendor plan id the mandate is addressed to. */
  readonly vendorPlanRef: string;
}

/**
 * Resolve the sold price of a plan, with the vendor plan id the provider needs.
 *
 * @param plan - The validated stored plan.
 * @param priceKey - The requested price key.
 * @returns The active price and its vendor ref, or `null` when unsellable.
 */
export function soldPrice(plan: Plan, priceKey: string): SoldPrice | null {
  const price = plan.prices.find(
    (candidate) => candidate.priceKey === priceKey && candidate.active
  );
  const ref = price?.externalRefs.find((candidate) => candidate.kind === "plan");
  if (price === undefined || ref === undefined) {
    return null;
  }
  return { price, vendorPlanRef: ref.id };
}

/** A `422 validation_failed` field entry naming one unsellable request field. */
export function unsoldField(path: string): {
  readonly path: string;
  readonly code: string;
  readonly message: string;
} {
  return {
    path,
    code: "not_found",
    message: "must name an active plan and price sold by the platform",
  };
}
