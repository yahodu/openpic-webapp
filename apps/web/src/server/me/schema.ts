import { z } from "zod";

/**
 * The `Me` response schema (OP-90, contract §1.2).
 *
 * The single bootstrap body the shell renders from. It is the route's response
 * schema, so `serializeResponse` enforces it strictly: a field the projection
 * forgot (or one it accidentally added) fails the request in test/dev rather
 * than reaching a client. The shape never carries another user's contact, a
 * push token or a raw storage key (§0.15).
 */

/** One active workspace membership as projected (§1.2). */
export const meTenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  role: z.enum(["owner", "admin", "member"]),
  status: z.string(),
});

/** The advisory capability projection (§0.14). */
export const meCapabilitiesSchema = z.object({
  canCreateEvent: z.boolean(),
  canPurchase: z.boolean(),
  isAdmin: z.boolean(),
});

/** The full `GET`/`PATCH /me` response body (§1.2). */
export const meSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  phoneNumber: z.string().nullable(),
  phoneNumberVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  accountCompletedAt: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  locale: z.string(),
  timeZone: z.string(),
  platformRole: z.string(),
  status: z.string(),
  marketingOptIn: z.boolean(),
  contactCapabilities: z.object({
    whatsappCapable: z.boolean().nullable(),
    whatsappCheckedAt: z.string().nullable(),
  }),
  primaryTenant: meTenantSchema.nullable(),
  tenants: z.array(meTenantSchema),
  capabilities: meCapabilitiesSchema,
  unreadNotificationCount: z.int(),
  pendingInvitationCount: z.int(),
  deletionScheduledAt: z.string().nullable(),
});

/** The projected `Me` body. */
export type Me = z.infer<typeof meSchema>;

/** One projected workspace membership. */
export type MeTenant = z.infer<typeof meTenantSchema>;
