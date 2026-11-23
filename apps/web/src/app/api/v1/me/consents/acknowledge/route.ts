import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { acknowledgeConsent } from "@/server/compliance/consents";
import { POLICY_PURPOSES } from "@/server/compliance/policies";
import { getRateLimitConfig, getTrustedClientIpHeader } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { resolveClientIp } from "@/server/rate-limit";
import { systemClock } from "@/server/runtime/clock";

/**
 * `POST /api/v1/me/consents/acknowledge` — record a policy acknowledgement
 * (OP-138, contract §8.2, schema §15.4; ADR-0898, ADR-0911).
 *
 * A thin delegate: the write itself is `acknowledgeConsent`
 * (`@/server/compliance/consents`), so the OP-140 `policy × acknowledge`
 * notification action can record the same acknowledgement without re-entering
 * this route or copying its insert. The route keeps its own body and answer
 * schemas — transport validation stays here — and its wire answer does not
 * move: a version the platform no longer serves is still `422
 * policy_version_stale` with the current version and URL, and **writes
 * nothing**.
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

    const receipt = await acknowledgeConsent({
      db: getDb(),
      userId: principal,
      purpose: ctx.body.purpose,
      policyVersion: ctx.body.policyVersion,
      now: systemClock.now(),
      evidence: {
        salt: getRateLimitConfig().salt,
        ip: resolveClientIp(ctx.request.headers, getTrustedClientIpHeader()) ?? null,
        userAgent: ctx.request.headers.get("user-agent"),
        acceptLanguage: ctx.request.headers.get("accept-language"),
      },
    });

    return { status: 201, body: receipt };
  },
});
