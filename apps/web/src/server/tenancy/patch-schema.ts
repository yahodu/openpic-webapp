import { z } from "zod";

/**
 * The `PATCH /api/v1/tenants/{tenantId}` body schema (OP-100, contract §2.1).
 *
 * Every field is optional and **at least one is required**. Nested `settings`
 * is an object rather than dotted keys, matching the §2.1 body description; the
 * route reports which fields it received so the `@/server/tenancy/permissions`
 * matrix can gate them (owner|admin, `billingContactUserId` owner only).
 *
 * The schema is deliberately a plain (stripping) object: unlike `PATCH /me`,
 * the contract names no `forbidden_field` case for this route, so an
 * unmodelled key is dropped rather than silently applying a server-owned field.
 */

/** The `PATCH /api/v1/tenants/{tenantId}` body schema. */
export const tenantPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    settings: z
      .object({
        defaultTimeZone: z.string().min(1).optional(),
        brandLogoAssetId: z.string().nullable().optional(),
        defaultWatermarkAssetId: z.string().nullable().optional(),
      })
      .optional(),
    billingContactUserId: z.string().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.billingContactUserId !== undefined ||
      (body.settings !== undefined && Object.values(body.settings).some((v) => v !== undefined)),
    { message: "At least one field is required." }
  );

/** The parsed `PATCH /api/v1/tenants/{tenantId}` body. */
export type TenantPatch = z.infer<typeof tenantPatchSchema>;
