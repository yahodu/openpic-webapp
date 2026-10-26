import { z } from "zod";

import { getDb } from "@/server/db/mongo";
import { normalizeInstantToUtc } from "@/server/events/dates";
import { computeDurationDays } from "@/server/events/windows";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { checkEntitlement } from "@/server/services/entitlements";
import { requireTenantScope, userAuth } from "@/server/tenancy/route-scope";
import { tenantStage } from "@/server/tenancy/route-stage";

/**
 * `POST /api/v1/tenants/{tenantId}/events:validate` — validate a **partial**
 * create-event body without consuming anything (OP-115, contract §4.1;
 * ADR-0520).
 *
 * Same auth + tenant stage as the create route, but **no** idempotency — the
 * endpoint is side-effect free (it never touches `usageCounters` or `events`,
 * I10) so a repeated request is already idempotent by construction. The body
 * is partial: only the fields the client sends are checked.
 *
 * The response is `200 { checks: [{ field, ok, code, limit, upgradePath }] }`.
 * The duration check is named `field: "durationDays"` and compares the span
 * against the plan's `events.duration_days` limit — for a span over the limit
 * it answers `{ ok: false, code: "plan_limit_exceeded", limit, upgradePath }`
 * (I10).
 */

/** One per-field validation result (contract §4.1, ADR-0520). */
const validateCheckSchema = z.object({
  field: z.string(),
  ok: z.boolean(),
  code: z.string().nullable(),
  limit: z.number().nullable(),
  upgradePath: z.string().nullable(),
});

/** The validate response: one check per field the partial body named. */
const validateResponseSchema = z.object({
  checks: z.array(validateCheckSchema),
});

/** The upgrade offer carried by a plan-limit denial (§0.14). */
const UPGRADE_PATH = "/api/v1/tenants/current/billing/upgrade";

/** The partial create-event body (every field optional). */
const validateBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  displayTimeZone: z.string().optional(),
  logoAssetId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable()
    .optional(),
  watermarkAssetId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .nullable()
    .optional(),
  publish: z.boolean().optional(),
  postUploadDays: z.number().int().min(0).nullable().optional(),
});

export const POST = defineRoute({
  route: "/api/v1/tenants/:tenantId/events:validate",
  body: validateBodySchema,
  response: validateResponseSchema,
  auth: (ctx, request) => userAuth()(ctx, request),
  tenant: tenantStage(),
  handler: async (ctx) => {
    const scope = requireTenantScope(ctx);
    const db = getDb();
    const tenantKey = scope.tenantId.toHexString();

    const checks: z.infer<typeof validateCheckSchema>[] = [];

    const { startAt, endAt } = ctx.body;
    if (startAt !== undefined && endAt !== undefined) {
      let from: string;
      let to: string;
      try {
        from = normalizeInstantToUtc(startAt);
        to = normalizeInstantToUtc(endAt);
      } catch {
        throw appError("validation_failed", {
          details: { fields: [{ path: "startAt", code: "invalid_instant", message: "" }] },
        });
      }
      if (Date.parse(to) <= Date.parse(from)) {
        checks.push({
          field: "dateRange",
          ok: false,
          code: "invalid_date_range",
          limit: null,
          upgradePath: null,
        });
      } else {
        const durationDays = computeDurationDays(new Date(from), new Date(to));
        const verdict = await checkEntitlement(
          tenantKey,
          "events.duration_days",
          durationDays,
          { counts: 0 },
          { db }
        );
        if (!verdict.allowed) {
          checks.push({
            field: "durationDays",
            ok: false,
            code: "plan_limit_exceeded",
            limit: verdict.limit,
            upgradePath: UPGRADE_PATH,
          });
        } else {
          checks.push({
            field: "durationDays",
            ok: true,
            code: null,
            limit: null,
            upgradePath: null,
          });
        }
      }
    }

    return { body: { checks } };
  },
});
