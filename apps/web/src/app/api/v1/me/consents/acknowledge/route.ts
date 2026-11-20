import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { POLICY_PURPOSES, currentPolicies } from "@/server/compliance/policies";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST /api/v1/me/consents/acknowledge` — record a policy acknowledgement
 * (OP-138, contract §8.2, schema §15.4; ADR-0898).
 *
 * A version the platform no longer serves is `422 policy_version_stale` with
 * the current version and URL, and **writes nothing**: silently recording a
 * stale version would destroy the evidence the record exists to provide. The
 * write itself carries the document digest, so the row is verifiable years
 * later.
 */

/** The acknowledgement body (§8.2). */
const acknowledgeBodySchema = z.object({
  purpose: z.enum(POLICY_PURPOSES),
  policyVersion: z.string().min(1),
});

/** The `201` receipt — the row the caller can read back. */
const acknowledgementSchema = z.object({
  id: z.string(),
  purpose: z.string(),
  policyVersion: z.string(),
  policyDocumentHash: z.string(),
  grantedAt: z.iso.datetime(),
  withdrawnAt: z.iso.datetime().nullable(),
});

export const POST = defineRoute({
  route: "/api/v1/me/consents/acknowledge",
  body: acknowledgeBodySchema,
  response: acknowledgementSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const principal = ctx.principal;
    if (principal === undefined) {
      throw appError("authentication_required");
    }

    const db = getDb();
    const settings = await getPlatformSettings({ db });
    const document = currentPolicies(settings).find((entry) => entry.purpose === ctx.body.purpose);

    if (document === undefined) {
      throw appError("validation_failed", { details: { fields: [] } });
    }

    if (ctx.body.policyVersion !== document.version) {
      throw appError("policy_version_stale", {
        details: { currentPolicyVersion: document.version, policyUrl: document.url },
      });
    }

    const now = systemClock.now();
    const consentId = new ObjectId();
    await platformRepo(db)
      .collection(COLLECTIONS.consents)
      .insertOne({
        _id: consentId,
        subject: { kind: "user", userId: new ObjectId(principal) },
        purpose: document.purpose,
        policyVersion: document.version,
        policyDocumentHash: document.documentHash,
        grantedAt: now,
        withdrawnAt: null,
        createdAt: now,
      });

    return {
      status: 201,
      body: {
        id: consentId.toHexString(),
        purpose: document.purpose,
        policyVersion: document.version,
        policyDocumentHash: document.documentHash,
        grantedAt: now.toISOString(),
        withdrawnAt: null,
      },
    };
  },
});
