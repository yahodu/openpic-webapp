import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { createIdentityLifecycleSeams } from "@/server/auth/identity-lifecycle";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { revokeCallerSessions } from "@/server/me/session-revocation";

/**
 * `POST /api/v1/me/sessions:revoke-all` — revoke the caller's sessions
 * (contract §1.3).
 *
 * Guarded with the `user` label. The revocation is performed through Better
 * Auth's `revoke-other-sessions` / `revoke-sessions` endpoint (so the library
 * owns the session store), then announced once through the identity lifecycle
 * seam (`createIdentityLifecycleSeams().sessionsRevoked`, ADR-0043 §3), which
 * emits the single `account.sessions.revoked` outbox row. The route never
 * writes that event directly.
 */

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

/** The request body: whether the caller's own session is kept (§1.3). */
const revokeAllBodySchema = z.object({ keepCurrent: z.boolean() });

export const POST = defineRoute({
  route: "/api/v1/me/sessions:revoke-all",
  body: revokeAllBodySchema,
  response: noContentSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }

    const { keepCurrent } = ctx.body;
    await revokeCallerSessions(ctx.request, keepCurrent);

    await createIdentityLifecycleSeams({ db: getDb() }).sessionsRevoked({ userId });

    getLogger().info("sessions revoked", {
      event: "me.sessions.revoked",
      userId,
      keepCurrent,
    });

    return { status: 204, body: null };
  },
});
