import { ObjectId } from "mongodb";
import { z } from "zod";

import { buildConsentEvidence } from "@/server/attendee/consent-evidence";
import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { POLICY_PURPOSES, currentPolicies } from "@/server/compliance/policies";
import { getRateLimitConfig, getTrustedClientIpHeader } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { resolveClientIp } from "@/server/rate-limit";
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
 * write itself carries the document digest and URL, so the row is verifiable
 * years later even after a rotation, and schema §15.4's evidence — salted
 * digests of the address and agent, never the raw values (§0.15) — records how
 * consent was given.
 */

/** How the in-app acknowledgement was given (§15.4, §8.2). */
const METHOD = "in_app_action";

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
        // The in-app acknowledgement is platform-scope: it names no event.
        eventId: null,
        subject: { kind: "user", userId: new ObjectId(principal) },
        purpose: document.purpose,
        policyVersion: document.version,
        policyDocumentHash: document.documentHash,
        // Stored, not derived: the current-policy list only holds the current
        // version, so a rotation would strip the URL from older rows.
        policyUrl: document.url,
        method: METHOD,
        evidence: buildConsentEvidence({
          salt: getRateLimitConfig().salt,
          ip: resolveClientIp(ctx.request.headers, getTrustedClientIpHeader()) ?? null,
          userAgent: ctx.request.headers.get("user-agent"),
          acceptLanguage: ctx.request.headers.get("accept-language"),
          method: METHOD,
        }),
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
