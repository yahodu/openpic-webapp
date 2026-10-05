import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { SESSION_COLLECTION } from "@/server/me/sessions";
import { revokeSessionToken } from "@/server/me/session-revocation";

/**
 * `DELETE /api/v1/me/sessions/{sessionId}` — revoke one of the caller's own
 * sessions (contract §1.3).
 *
 * Guarded with the `user` label. A foreign or unknown id is `404 not_found`
 * (never `403`, so the endpoint is not an existence oracle); an owned session
 * is revoked through Better Auth and answers `204`.
 *
 * The path segment is read from the request URL rather than a Next.js `params`
 * argument, because the shared `defineRoute` pipeline exposes only `(request)`.
 */

/** The `204` body placeholder: the pipeline serves no body for this status. */
const noContentSchema = z.null();

/** The `{sessionId}` segment of the matched path, or `null`. */
function sessionIdFromRequest(request: Request): string | null {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? null;
}

export const DELETE = defineRoute({
  route: "/api/v1/me/sessions/:sessionId",
  response: noContentSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }

    const sessionId = sessionIdFromRequest(ctx.request);
    if (sessionId === null || !ObjectId.isValid(sessionId)) {
      throw appError("not_found");
    }

    const session = await getDb()
      .collection(SESSION_COLLECTION)
      .findOne({ _id: new ObjectId(sessionId), userId: new ObjectId(userId) });

    if (session === null || typeof session.token !== "string") {
      throw appError("not_found");
    }

    await revokeSessionToken(ctx.request, session.token);

    getLogger().info("session revoked", {
      event: "me.session.revoked",
      userId,
      sessionId,
    });

    return { status: 204, body: null };
  },
});
