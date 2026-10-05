import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";

/**
 * `GET /api/v1/me` — the caller's own account (contract §1.2).
 *
 * OP-86 guards the route with the `user` auth label so the deployed HTTP
 * surface exercises the shared guard (E1, ADR-0025 §6). The response body is
 * OP-88's contract; the handler here exists only to give the guard a protected
 * target.
 */

/** Placeholder response while the `/me` body is owned by OP-88. */
const MeResponseSchema = z.object({});

/** Return an empty account body behind the `user` guard. */
export const GET = defineRoute({
  route: "/api/v1/me",
  response: MeResponseSchema,
  // Built per request: `getAuth()`/`getDb()` read validated configuration, so
  // evaluating them at module scope would fail `next build`'s page-data
  // collection (which runs without a configured environment).
  //
  // `allowBanned` because `GET /me` is on the contract §0.3 ban-exemption list
  // (`GET /me`, `POST /me/data-requests`): a banned user may read the route
  // that tells them why they are banned.
  auth: (ctx, request) =>
    requireAuth("user", { auth: getAuth(), database: getDb(), allowBanned: true })(ctx, request),
  handler: () => ({ body: {} }),
});
