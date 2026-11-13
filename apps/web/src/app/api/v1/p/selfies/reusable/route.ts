import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getConfig } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { buildCursorPage, parsePageQuery } from "@/server/http/cursor";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { createMediaSigner } from "@/server/media/signer";
import { crossTenantReads } from "@/server/repos";

/**
 * `GET /api/v1/p/selfies/reusable` — the caller's reusable selfies (OP-132,
 * contract §6.3, §0.8, §0.15; ADR-0792, ADR-0810).
 *
 * The PRD's "reuse a previous selfie" needs a preview the attendee recognises,
 * so the answer carries the four safe facts and nothing else: the id, when it
 * was taken, a **signed preview** URL and the quality verdict. The face vector
 * is what unlocks matching, so it never leaves the database (§0.15) — the
 * listing is the one read that could leak it by accident.
 *
 * Every item is signed per request, so the list is **bounded and cursor-paged**
 * on §0.8's machinery (ADR-0810): one over-fetched row beyond `limit` is what
 * tells the page builder whether more exist.
 *
 * Auth is `user` (identified only): an anonymous attendee has an `op_att`
 * session but no account to reuse a selfie across events with, so it answers
 * `401 authentication_required`.
 */

/** One reusable selfie as §6.3 shows it — exactly four keys. */
const reusableSelfieSchema = z.object({
  selfieId: z.string(),
  createdAt: z.string(),
  previewUrl: z.string(),
  quality: z.object({ accepted: z.boolean() }),
});

/** The §6.3 page member. No `total`: §0.8 wants a cached counter for one. */
const reusablePageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
});

/** The §6.3 answer. */
const reusableResponseSchema = z.object({
  data: z.array(reusableSelfieSchema),
  page: reusablePageSchema,
});

export const GET = defineRoute({
  route: "/api/v1/p/selfies/reusable",
  response: reusableResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const { principal } = ctx;
    if (principal === undefined) {
      // The `user` auth stage always publishes the principal, or denies.
      throw appError("internal_error");
    }

    const { limit, cursor } = parsePageQuery(new URL(ctx.request.url).searchParams);
    const fetched = await crossTenantReads.findReusableSelfiesBySubjectUser(
      principal,
      // One row beyond the page: its presence is the only `hasMore` signal.
      { limit: limit + 1, ...(cursor === null ? {} : { cursor }) },
      getDb()
    );
    const page = buildCursorPage(fetched.items, limit, (item) => ({
      c: item.createdAt.toISOString(),
      i: item.id,
    }));
    const signer = createMediaSigner({
      currentSecret: getConfig().media.signingSecretCurrent,
    });

    return {
      body: {
        data: page.items.map((item) => ({
          selfieId: item.id,
          createdAt: item.createdAt.toISOString(),
          // The preview derivative, not the original: a listing shows a crop.
          previewUrl: signer.sign({
            kind: "preview",
            contentHash: item.contentHash,
            ext: "webp",
          }).url,
          quality: item.quality,
        })),
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit },
      },
    };
  },
});
