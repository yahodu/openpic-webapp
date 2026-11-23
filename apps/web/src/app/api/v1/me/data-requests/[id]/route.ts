import { ObjectId } from "mongodb";
import { z } from "zod";

import { verifyDsrReceipt } from "@/server/compliance/receipt";
import { isoOf } from "@/server/compliance/serialize";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

import { acknowledgementFor } from "../_lib/acknowledgement";
import { dsrReadAuth, liveAttendeeSession } from "../_lib/principal";

/**
 * `GET /api/v1/me/data-requests/{id}` — the data subject reads their own request
 * back (OP-138, contract §8.1, schema §20.3; ADR-0898, ADR-0902 §5).
 *
 * The row belongs to its own data subject alone — the signed-in user **or** the
 * anonymous attendee session that filed it, so the `pollUrl` a receipt named
 * answers its recipient. Any other credential is `404 not_found`, never `403`,
 * so the endpoint is not an existence oracle. The owner gets the counted
 * `executionLog` — "we deleted 412 embeddings" is the whole point — and `export`
 * stays `null` until an export exists.
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
  auth: dsrReadAuth,
  handler: async (ctx) => {
    const db = getDb();
    const principal = ctx.principal;
    const requestId = requestIdFrom(ctx.request);
    const receipt = new URL(ctx.request.url).searchParams.get("receipt");

    // A receipt is a credential in its own right: it must verify, and it is only
    // good for the id it names. A valid token for another id is the ordinary
    // not-found answer, never a confirmation that the id exists (§8.1).
    if (receipt !== null) {
      const verdict = verifyDsrReceipt(receipt, getConfig().internal.apiSecret);
      if (!verdict.valid) {
        throw appError("unauthenticated");
      }
      if (requestId?.toHexString() !== verdict.requestId) {
        throw appError("not_found", { details: { resource: "data_request" } });
      }
    }

    // The owner is the signed-in user, the live attendee session, or — once that
    // session has lapsed or gone — the receipt itself. The receipt only ever
    // reads an anonymous row, so a user's row cannot be opened with one.
    let owner: Record<string, unknown>;
    if (principal !== undefined) {
      owner = { "subject.kind": "user", "subject.userId": new ObjectId(principal) };
    } else if (receipt !== null) {
      const session = await liveAttendeeSession(ctx.request);
      owner =
        session === null
          ? { "subject.kind": "anonymous" }
          : {
              "subject.kind": "anonymous",
              "subject.attendeeSessionId": session._id.toHexString(),
            };
    } else {
      // The session that filed it is the credential `dsrAuth` already resolved,
      // so the detail read does not pay for the same `attendeeSessions` lookup
      // twice (OP-138).
      const sessionId = ctx.attendeeSessionId;
      if (sessionId === undefined) {
        throw appError("unauthenticated");
      }
      owner = { "subject.kind": "anonymous", "subject.attendeeSessionId": sessionId };
    }

    const row =
      requestId === null
        ? null
        : ((await platformRepo(db)
            .collection(COLLECTIONS.dataSubjectRequests)
            .findOne({ _id: requestId, ...owner })) as Record<string, unknown> | null);

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
