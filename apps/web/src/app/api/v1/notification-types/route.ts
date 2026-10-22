import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import {
  dedupeSchema,
  throttleSchema,
  type NotificationType,
} from "@/server/notifications/notification-types";
import { listEnabledNotificationTypes } from "@/server/notifications/notification-types-read";
import { humaniseKey } from "@/server/notifications/preferences";

/**
 * `GET /api/v1/notification-types` (contract §7.6; schema §19.1; ADR-0220,
 * ADR-0221).
 *
 * The catalogue is served **as data** so the settings screen can be built
 * generically and never hard-codes the 81-key list. The route is `user`-guarded,
 * answers `{ data: [...] }` with the §7.6 projection of every **enabled**
 * `notificationTypes` document, filters on `category` and `audience`, and is
 * cacheable: `Cache-Control: private, max-age=600`.
 *
 * The one field that must never reach the wire is `retainBody`: it governs the
 * internal dispatch ledger for OTP types (design rule 6), is not part of the
 * §7.6 shape, and is an internal storage decision the client must not observe.
 */

/** One channel group as the §7.6 catalogue serves it. */
const catalogueChannelGroupSchema = z.object({
  group: z.string(),
  enabled: z.boolean(),
  optOutAllowed: z.boolean(),
  candidates: z.array(z.string()).optional(),
  strategy: z.string().optional(),
});

/** One catalogue item (contract §7.6) — deliberately without `retainBody`. */
const catalogueItemSchema = z.object({
  typeKey: z.string(),
  category: z.string(),
  label: z.string(),
  description: z.string(),
  audiences: z.array(z.string()),
  channelGroups: z.array(catalogueChannelGroupSchema),
  transactional: z.boolean(),
  severity: z.string(),
  respectQuietHours: z.boolean(),
  throttle: throttleSchema,
  dedupe: dedupeSchema,
  actionable: z.boolean(),
  enabled: z.boolean(),
  version: z.number(),
});

/** The `{ data }` envelope (contract §7.6). */
export const notificationTypesResponseSchema = z.object({ data: z.array(catalogueItemSchema) });

/**
 * Project one stored type onto the §7.6 item shape.
 *
 * `label`/`description` are read-route copy: the seed stores none, so a
 * humanised `typeKey` is the label and the description defaults to the empty
 * string (contract §7.6 pins only that they are strings).
 *
 * @param type - The validated catalogue type.
 * @returns The §7.6 projection, with `retainBody` omitted.
 */
function projectCatalogueItem(type: NotificationType) {
  return {
    typeKey: type.typeKey,
    category: type.category,
    label: type.label ?? humaniseKey(type.typeKey),
    description: type.description ?? "",
    audiences: [...type.audiences],
    channelGroups: type.channelGroups.map((group) => ({
      group: group.group,
      enabled: group.enabled,
      optOutAllowed: group.optOutAllowed,
      ...(group.candidates === undefined ? {} : { candidates: [...group.candidates] }),
      ...(group.strategy === undefined ? {} : { strategy: group.strategy }),
    })),
    transactional: type.transactional,
    severity: type.severity,
    respectQuietHours: type.respectQuietHours,
    throttle: type.throttle,
    dedupe: type.dedupe,
    actionable: type.actionable,
    enabled: type.enabled,
    version: type.version,
  };
}

export const GET = defineRoute({
  route: "/api/v1/notification-types",
  response: notificationTypesResponseSchema,
  auth: (ctx, request) => requireAuth("user", { auth: getAuth(), database: getDb() })(ctx, request),
  handler: async (ctx) => {
    const params = new URL(ctx.request.url).searchParams;
    const category = params.get("category");
    const audience = params.get("audience");

    const catalogue = await listEnabledNotificationTypes({ db: getDb() });
    const data = catalogue
      .filter((type) => category === null || type.category === category)
      .filter((type) => audience === null || type.audiences.some((tag) => tag === audience))
      .map(projectCatalogueItem);

    return {
      body: { data },
      headers: { "cache-control": "private, max-age=600" },
    };
  },
});
