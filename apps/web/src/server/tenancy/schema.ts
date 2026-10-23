import { z } from "zod";

/**
 * The tenant DTO (OP-100, contract §2.1, schema §13.3).
 *
 * It is the response schema of both `GET` and `PATCH /api/v1/tenants/{tenantId}`,
 * so `serializeResponse` enforces it strictly: a field the projection forgot (or
 * one it accidentally added) fails the request in test/dev rather than reaching
 * a client.
 *
 * `counters.approximate` is a `true` literal, not a boolean: §2.1 makes the
 * cached, nightly-reconciled nature of these counts mandatory to advertise, so
 * omitting it is a contract violation rather than a default. The branding
 * *URLs* stay `null` until the OP-117 signer exists (GREEN scope §3); the stored
 * asset ids are deliberately not part of the wire DTO, exactly as §2.1 shows.
 */

/** The cached dashboard counters (schema §13.3, reconciled nightly per P7). */
export const tenantCountersSchema = z.object({
  eventCount: z.number().int(),
  activeEventCount: z.number().int(),
  imageCount: z.number().int(),
  storageBytes: z.number().int(),
  attendeeCount: z.number().int(),
  approximate: z.literal(true),
  reconciledAt: z.string().nullable(),
});

/** The workspace settings the DTO exposes (schema §13.3). */
export const tenantSettingsSchema = z.object({
  defaultTimeZone: z.string(),
  brandLogoUrl: z.string().nullable(),
  defaultWatermarkUrl: z.string().nullable(),
});

/** The full `GET`/`PATCH /api/v1/tenants/{tenantId}` response body (§2.1). */
export const tenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(["active", "suspended", "closed"]),
  ownerUserId: z.string().nullable(),
  billingContactUserId: z.string().nullable(),
  dataRegion: z.enum(["in", "eu"]),
  myRole: z.enum(["owner", "admin", "member"]),
  counters: tenantCountersSchema,
  settings: tenantSettingsSchema,
  createdAt: z.string(),
});

/** The projected tenant body. */
export type Tenant = z.infer<typeof tenantSchema>;
