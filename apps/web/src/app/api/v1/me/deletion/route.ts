import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { USER_PROFILES_COLLECTION } from "@/server/auth/identity-hooks";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import {
  computeDeletionScheduledAt,
  DELETION_PATH,
  deletionRequestSchema,
  deletionResponseSchema,
} from "@/server/me/deletion";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST` / `DELETE /api/v1/me/deletion` — the account-deletion cancel window
 * (contract §1.4).
 *
 * `POST` (guarded `user`) verifies `confirmEmail`, schedules the purge
 * `platformSettings.account.deletionGraceDays` out and sets the profile
 * `deletion_pending`; nothing is deleted immediately (the purge belongs to the
 * `account-deletion-purge` cron). `DELETE` (guarded `user`, exempting the
 * deletion states) cancels inside the window and restores the profile to
 * `active`, or is `409 deletion_already_executed` once the purge may have run.
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

/** The `userProfiles` fields this route reads and writes. */
interface DeletionProfile {
  readonly status?: unknown;
  readonly deletionScheduledAt?: unknown;
}

export const POST = defineRoute({
  route: "/api/v1/me/deletion",
  body: deletionRequestSchema,
  response: deletionResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }

    const database = getDb();
    const objectId = new ObjectId(userId);

    const user = await database.collection(USER_COLLECTION).findOne({ _id: objectId } as never);
    const email = typeof user?.email === "string" ? user.email : "";
    if (ctx.body.confirmEmail !== email) {
      throw appError("confirmation_mismatch", { details: { field: "confirmEmail" } });
    }

    const settings = await getPlatformSettings({ db: database });
    const now = new Date();
    const scheduledAt = computeDeletionScheduledAt(now, settings);

    await database.collection(USER_PROFILES_COLLECTION).updateOne(
      { userId: objectId },
      {
        $set: {
          status: "deletion_pending",
          deletionScheduledAt: scheduledAt,
          updatedAt: now,
        },
      }
    );

    getLogger().info("account deletion requested", {
      event: "me.deletion.requested",
      userId,
      scheduledAt: scheduledAt.toISOString(),
    });

    const scheduledIso = scheduledAt.toISOString();
    return {
      status: 202,
      body: {
        status: "deletion_pending" as const,
        scheduledAt: scheduledIso,
        cancelUntil: scheduledIso,
        cancelUrl: DELETION_PATH,
      },
    };
  },
});

export const DELETE = defineRoute({
  route: "/api/v1/me/deletion",
  response: noContentSchema,
  // The caller is `deletion_pending` for the whole cancel window, which the
  // default `user` guard denies; the exemption lets the handler decide whether
  // the window is still open (ADR-0068 §4).
  auth: (ctx, request) =>
    requireAuth("user", { auth: getAuth(), database: getDb(), allowDeletionPending: true })(
      ctx,
      request
    ),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }

    const database = getDb();
    const objectId = new ObjectId(userId);
    const profile = await database
      .collection<DeletionProfile>(USER_PROFILES_COLLECTION)
      .findOne({ userId: objectId } as never);

    const status = profile?.status;
    const scheduledAt = profile?.deletionScheduledAt;
    const purgeStarted =
      status === "deleted" ||
      (status === "deletion_pending" &&
        scheduledAt instanceof Date &&
        scheduledAt.getTime() <= Date.now());

    if (purgeStarted) {
      throw appError("deletion_already_executed");
    }

    await database
      .collection(USER_PROFILES_COLLECTION)
      .updateOne(
        { userId: objectId },
        { $set: { status: "active", deletionScheduledAt: null, updatedAt: new Date() } }
      );

    getLogger().info("account deletion cancelled", {
      event: "me.deletion.cancelled",
      userId,
    });

    return { status: 204, body: null };
  },
});
