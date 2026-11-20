import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { isoOf } from "@/server/compliance/serialize";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

import { acknowledgementFor } from "../_lib/acknowledgement";

/**
 * `GET /api/v1/me/data-requests/{id}` — the data subject reads their own request
 * back (OP-138, contract §8.1, schema §20.3; ADR-0898).
 *
 * The row belongs to its own data subject alone: another user's id is
 * `404 not_found`, never `403`, so the endpoint is not an existence oracle. The
 * owner gets the counted `executionLog` — "we deleted 412 embeddings" is the
 * whole point — and `export` stays `null` until an export exists.
 */

/** One counted execution step (schema §20.3). */
const executionStepSchema = z.object({
  step: z.string(),
  count: z.number(),
  at: z.iso.datetime(),
});

/** The owner's view of one request. */
const detailSchema = z.object({
  id: z.string(),
  requestType: z.string(),
  regulation: z.string(),
  status: z.string(),
  slaDueAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  acknowledgement: z.string(),
  completedAt: z.iso.datetime().nullable(),
  executionLog: z.array(executionStepSchema),
  // `shortcut: export delivery is OP-150's (execution + signed URL), so the
  // field is null until an export exists; the pinned cases only cover null.`
  export: z.null(),
});

/** The `{id}` path segment, or `null` when absent or malformed. */
function requestIdFrom(request: Request): ObjectId | null {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments.at(-1);
  return raw !== undefined && ObjectId.isValid(raw) ? new ObjectId(raw) : null;
}

export const GET = defineRoute({
  route: "/api/v1/me/data-requests/:id",
  response: detailSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const requestId = requestIdFrom(ctx.request);
    const row =
      requestId === null
        ? null
        : ((await platformRepo(getDb())
            .collection(COLLECTIONS.dataSubjectRequests)
            .findOne({
              _id: requestId,
              "subject.kind": "user",
              "subject.userId": new ObjectId(principal),
            })) as Record<string, unknown> | null);

    if (row === null) {
      throw appError("not_found", { details: { resource: "data_request" } });
    }

    const rawLog = Array.isArray(row.executionLog) ? row.executionLog : [];
    const slaDueAt = isoOf(row.slaDueAt);

    return {
      body: {
        id: String(row._id),
        requestType: String(row.requestType),
        regulation: String(row.regulation),
        status: String(row.status),
        slaDueAt,
        receivedAt: isoOf(row.receivedAt),
        acknowledgement: acknowledgementFor(new Date(slaDueAt)),
        completedAt: row.completedAt instanceof Date ? row.completedAt.toISOString() : null,
        executionLog: rawLog.map((entry) => {
          const step = entry as Record<string, unknown>;
          return { step: String(step.step), count: Number(step.count), at: isoOf(step.at) };
        }),
        export: null,
      },
    };
  },
});
