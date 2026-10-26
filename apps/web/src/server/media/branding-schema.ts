import { z } from "zod";

/**
 * Branding upload wire schemas (OP-114, API contract §2.1).
 *
 * The `201` envelope is exactly `{ assetId, kind, url, bytes }` — the route
 * declares it as the response schema (`.strict()` — the serializer enforces
 * strictness for `ZodObject`s anyway, so a response with an extra key is a
 * developer-facing failure rather than a silent leak). The `kind` form field
 * is the other wire value the routes echo into the stored row and the
 * response; it is a closed vocabulary (`event_logo` | `watermark`).
 */

/** The closed `kind` vocabulary the branding endpoint admits (contract §2.1). */
export const BRANDING_KIND_VALUES = ["event_logo", "watermark"] as const;

/** A member of the branding `kind` vocabulary. */
export type BrandingKind = (typeof BRANDING_KIND_VALUES)[number];

/**
 * The `201` response envelope: the stored asset id, the echoed kind, the
 * signed media URL and the **stored** byte count (sanitized length for SVG).
 */
export const brandingUploadResponseSchema = z
  .object({
    assetId: z.string(),
    kind: z.string(),
    url: z.string(),
    bytes: z.number(),
  })
  .strict();

/** The response DTO inferred from {@link brandingUploadResponseSchema}. */
export type BrandingUploadResponse = z.infer<typeof brandingUploadResponseSchema>;
