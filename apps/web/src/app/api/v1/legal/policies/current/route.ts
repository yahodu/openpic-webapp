import { z } from "zod";

import { currentPolicies } from "@/server/compliance/policies";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `GET /api/v1/legal/policies/current` — the public current-policy document
 * (OP-138, contract §8.2; ADR-0898).
 *
 * Public, because a data subject must be able to read the document they are
 * asked to acknowledge before they hold any credential. The answer is
 * cacheable for an hour (`Cache-Control: public, max-age=3600`), and every row
 * carries the same `policyDocumentHash` a consent record stores, so the client
 * can verify it read the document the platform recorded.
 */

/** One current policy document (§8.2). */
const policySchema = z.object({
  purpose: z.string(),
  version: z.string(),
  url: z.string(),
  effectiveFrom: z.iso.datetime(),
  documentHash: z.string(),
});

/** The §8.2 cache lifetime. */
const CACHE_CONTROL = "public, max-age=3600";

export const GET = defineRoute({
  route: "/api/v1/legal/policies/current",
  response: z.object({ policies: z.array(policySchema) }),
  handler: async () => {
    const settings = await getPlatformSettings({ db: getDb() });
    return {
      body: { policies: [...currentPolicies(settings)] },
      headers: { "cache-control": CACHE_CONTROL },
    };
  },
});
