import { z } from "zod";

/**
 * The `PATCH /me` body schema (OP-90, contract §1.2).
 *
 * Every field is optional and **at least one is required**. `displayName` is
 * trimmed and 1–80 characters; `marketingOptIn` is a real boolean (an explicit
 * `false` counts as a provided field); `avatarAssetId` may be `null` to clear
 * the avatar.
 *
 * The schema is **passthrough**, not strict and not stripping: the route must
 * still see a supplied `email`/`phoneNumber`/`platformRole` to reject it with
 * `422 forbidden_field`. A stripping schema would hand the route an empty
 * object and the request would be mishandled as a no-op.
 *
 * Field-level rejections that need the stored data or a catalogue error code —
 * an unknown IANA zone → `422 unknown_timezone`, and camera/internally-owned
 * fields such as `email`, `phoneNumber` and `platformRole` → `422
 * forbidden_field` — are applied by the route, not by this pure schema.
 */

/** The fields `PATCH /me` may set (contract §1.2). */
export const ME_PATCH_EDITABLE_FIELDS = [
  "displayName",
  "locale",
  "timeZone",
  "marketingOptIn",
  "avatarAssetId",
] as const;

/**
 * The `PATCH /me` body schema.
 *
 * @example
 * mePatchSchema.parse({ displayName: "  Rahul  " }).displayName; // "Rahul"
 */
export const mePatchSchema = z
  .looseObject({
    displayName: z.string().trim().min(1).max(80).optional(),
    locale: z.enum(["en-IN"]).optional(),
    timeZone: z.string().min(1).optional(),
    marketingOptIn: z.boolean().optional(),
    avatarAssetId: z.string().nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "At least one field is required.",
  });

/** The parsed `PATCH /me` body. */
export type MePatch = z.infer<typeof mePatchSchema>;
