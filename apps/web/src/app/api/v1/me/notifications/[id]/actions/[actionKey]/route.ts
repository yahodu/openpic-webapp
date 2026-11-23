import { ObjectId, type Db } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { startOutstandingCharge } from "@/server/billing/charge-outstanding";
import { decideInvitation } from "@/server/collaboration/invitation-transition";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { closeActionAffordance } from "@/server/notifications/action-affordance";
import {
  mapActionOutcome,
  resolveActionDelegation,
  type DelegateResult,
  type NotificationActionDelegation,
} from "@/server/notifications/notification-actions";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

import { notificationIdFromRequest } from "../../../_lib/notification-id";

/**
 * `POST /api/v1/me/notifications/{id}/actions/{actionKey}` — act on a feed row
 * (OP-140, contract §7.3; notification design §7).
 *
 * Guarded with the `user` label and rate class `write.normal`. The endpoint owns
 * **no state**: a notification is a pointer, and the `actionTarget`'s own
 * document owns the outcome. So the handler loads the caller's own row (`404`
 * for an unknown, malformed or foreign id — never `403`), refuses a key the row
 * does not carry or §7.3 does not serve (`422`), delegates to the owning domain
 * service and projects that service's answer onto the nine §7.3 keys.
 *
 * The denormalised `actions[].state` is allowed to be stale, so it never
 * short-circuits a decision: the owning document answers, and the response
 * carries the affordance **re-read after** the delegation.
 */

/** One stored affordance as the response projects it (§7.3). */
const storedActionSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: z.string(),
});

/** The nine §7.3 action-response keys. */
const actionResponseSchema = z.object({
  notificationId: z.string(),
  actionKey: z.string(),
  outcome: z.enum(["applied", "already_resolved", "unavailable"]),
  alreadyResolved: z.boolean(),
  resolvedVia: z.string().nullable(),
  targetState: z.string(),
  actions: z.array(storedActionSchema),
  redirectUrl: z.string().nullable(),
  message: z.string(),
});

/** The stored `notifications` fields this endpoint reads (schema §19.4). */
interface StoredNotificationRow {
  readonly _id: ObjectId;
  readonly typeKey?: unknown;
  readonly actionTarget?: unknown;
  readonly actions?: unknown;
}

/** True for a plain record (a stored sub-document). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project a stored row's `actions` onto the §7.3 `{ key, label, state }` pairs.
 *
 * @param actions - The stored array (unvalidated).
 * @returns The affordances that carry the three projected facts.
 */
function projectActions(actions: unknown): z.infer<typeof storedActionSchema>[] {
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions.flatMap((action) => {
    const parsed = storedActionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The `{id}` and `{actionKey}` segments of the matched path. */
function actionPathOf(request: Request): { notificationId: ObjectId | null; actionKey: string } {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const notificationId = notificationIdFromRequest(request, 3);
  const actionKey = segments.at(-1) ?? "";
  return { notificationId, actionKey };
}

/**
 * Delegate one action to the service that owns its target (§7.3).
 *
 * @param input - The row, the delegation, the target pointer and the caller.
 * @returns What the delegated service reported.
 * @throws The delegated service's own refusal (`403`, `409`, `410`, `502`, …).
 */
async function delegateAction(input: {
  readonly db: Db;
  readonly row: StoredNotificationRow;
  readonly delegation: NotificationActionDelegation;
  readonly kind: string;
  readonly target: { readonly id: string; readonly state: string };
  readonly actionKey: string;
  readonly userId: string;
  readonly now: Date;
}): Promise<DelegateResult> {
  const { db, row, delegation, kind, target, actionKey, userId, now } = input;

  if (!ObjectId.isValid(target.id)) {
    throw appError("validation_failed", {
      details: {
        fields: [{ path: "actionTarget.id", code: "custom", message: "must be a 24-hex ObjectId" }],
      },
    });
  }

  if (delegation.service === "invitation_decision" && delegation.decision !== undefined) {
    const body = await decideInvitation(
      { db, decision: delegation.decision, via: "in_app", userId, now },
      new ObjectId(target.id)
    );
    return {
      outcome: body.alreadyResolved ? "already_resolved" : "applied",
      targetState: body.status,
      resolvedVia: body.resolvedVia,
      ...(body.redirectUrl === undefined ? {} : { redirectUrl: body.redirectUrl }),
    };
  }

  if (delegation.service === "retry_charge") {
    const charge = await startOutstandingCharge({
      db,
      subscriptionId: new ObjectId(target.id),
      requesterUserId: userId,
      idempotencyKey: `notification-action:${row._id.toHexString()}:${actionKey}`,
      now,
    });
    // The charge service settles the ledger; the §7.3 fan-out is the endpoint's,
    // keyed on the row's own kind so the next delegate arm inherits it.
    await closeActionAffordance(db, { kind, id: target.id }, now);
    return {
      outcome: charge.kind === "charged" ? "applied" : "already_resolved",
      targetState: charge.subscriptionStatus,
    };
  }

  // shortcut: the other five §7.3 rows have no extracted domain service on the
  // trunk yet (ADR-0942's out-of-scope list); answer unavailable rather than a
  // 500 until their owning card lands one.
  return { outcome: "unavailable", targetState: target.state };
}

export const POST = defineRoute({
  route: "/api/v1/me/notifications/:id/actions/:actionKey",
  response: actionResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const { notificationId, actionKey } = actionPathOf(ctx.request);
    if (notificationId === null) {
      throw appError("not_found", { details: { resource: "notification" } });
    }

    const db = getDb();
    const userId = new ObjectId(principal);
    const notifications = platformRepo(db).collection(COLLECTIONS.notifications);

    // Ownership is part of the filter, so a foreign row is indistinguishable
    // from a missing one.
    const row = ((await notifications.findOne({ _id: notificationId, userId })) ??
      null) as StoredNotificationRow | null;
    if (row === null) {
      throw appError("not_found", { details: { resource: "notification" } });
    }

    const actions = projectActions(row.actions);
    if (!actions.some((action) => action.key === actionKey)) {
      throw appError("validation_failed", {
        details: {
          fields: [
            { path: "actionKey", code: "custom", message: "is not an action of this notification" },
          ],
        },
      });
    }

    const actionTarget = isRecord(row.actionTarget) ? row.actionTarget : {};
    const kind = typeof actionTarget.kind === "string" ? actionTarget.kind : "";
    const targetId = typeof actionTarget.id === "string" ? actionTarget.id : "";
    const targetState = typeof actionTarget.state === "string" ? actionTarget.state : "unknown";
    const delegation = resolveActionDelegation({ kind, actionKey });
    if (delegation === null) {
      throw appError("validation_failed", {
        details: {
          fields: [{ path: "actionKey", code: "custom", message: "has no §7.3 delegate" }],
        },
      });
    }

    const now = systemClock.now();
    const result = await delegateAction({
      db,
      row,
      delegation,
      kind,
      target: { id: targetId, state: targetState },
      actionKey,
      userId: principal,
      now,
    });

    // The affordance the next `GET /me/notifications` serves: re-read, never the
    // row the handler loaded before the transition.
    const refreshed = ((await notifications.findOne({ _id: notificationId, userId })) ??
      null) as StoredNotificationRow | null;
    const view = mapActionOutcome(result);

    getLogger().info("notification action", {
      event: "notification.action",
      typeKey: typeof row.typeKey === "string" ? row.typeKey : null,
      actionKey,
      outcome: view.outcome,
    });

    return {
      body: {
        notificationId: notificationId.toHexString(),
        actionKey,
        ...view,
        actions: projectActions(refreshed?.actions),
      },
    };
  },
});
