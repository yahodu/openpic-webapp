import { ObjectId } from "mongodb";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import {
  SESSION_COLLECTION,
  sessionsListSchema,
  toSessionSummary,
  type StoredSession,
} from "@/server/me/sessions";

/**
 * `GET /api/v1/me/sessions` — the caller's active sessions (contract §1.3).
 *
 * Guarded with the `user` label. The list is caller-scoped and active-only
 * (an expired session is not listed), and each item is the §1.3 projection —
 * raw `ipAddress`, `userAgent`, `token` and `userId` are never returned
 * (§0.15); `ipCountry` is `null` until a geo resolver lands (ADR-0068 §6).
 */
export const GET = defineRoute({
  route: "/api/v1/me/sessions",
  response: sessionsListSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }

    const now = new Date();
    const sessions = await getDb()
      .collection<StoredSession>(SESSION_COLLECTION)
      .find({ userId: new ObjectId(userId), expiresAt: { $gt: now } } as never)
      .toArray();

    const currentSessionId = ctx.sessionId ?? null;
    return {
      body: { data: sessions.map((session) => toSessionSummary(session, currentSessionId)) },
    };
  },
});
