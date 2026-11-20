import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { isoOf, isoOrNull } from "@/server/compliance/serialize";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

/**
 * `GET /api/v1/me/consents?purpose=` — the caller's own consent history
 * (OP-138, contract §8.2, schema §15.4; ADR-0898).
 *
 * Consent records are the evidence that a processing decision was lawful years
 * later, so every row carries the `policyDocumentHash` of the document the
 * caller acknowledged. §8.2 spells the answer as a bare array.
 */

/** One stored consent record (§8.2). */
const consentRowSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  policyVersion: z.string(),
  policyDocumentHash: z.string(),
  grantedAt: z.iso.datetime(),
  withdrawnAt: z.iso.datetime().nullable(),
});

export const GET = defineRoute({
  route: "/api/v1/me/consents",
  response: z.array(consentRowSchema),
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const purpose = new URL(ctx.request.url).searchParams.get("purpose");
    const rows = (await platformRepo(getDb())
      .collection(COLLECTIONS.consents)
      .find({
        "subject.kind": "user",
        "subject.userId": new ObjectId(principal),
        ...(purpose === null ? {} : { purpose }),
      })
      .sort({ grantedAt: -1, _id: -1 })
      .toArray()) as Record<string, unknown>[];

    return {
      body: rows.map((row) => ({
        id: String(row._id),
        purpose: String(row.purpose),
        policyVersion: String(row.policyVersion),
        policyDocumentHash: String(row.policyDocumentHash),
        grantedAt: isoOf(row.grantedAt),
        withdrawnAt: isoOrNull(row.withdrawnAt),
      })),
    };
  },
});
