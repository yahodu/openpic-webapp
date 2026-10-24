import { z } from "zod";

import { idSchema, isoDateTimeSchema, maskedContactSchema } from "@openpic/contracts";

/**
 * The workspace-member DTO (OP-101, contract §2.2, schema §13.4).
 *
 * `GET /api/v1/tenants/{tenantId}/members` returns `{ data: Member[] }` and the
 * member shape is exactly §2.2's: `displayName` plus a §0.13 **masked** contact
 * (`emailMasked`) — there is no raw `email`/`phone` field on the wire (§0.15),
 * and `serializeResponse` enforces that strictly, so a projection that
 * accidentally carried the full address would fail rather than leak.
 */

/** A workspace role (schema §13.4). */
export const memberRoleSchema = z.enum(["owner", "admin", "member"]);

/** A membership's lifecycle status (schema §13.4). */
export const memberStatusSchema = z.enum(["active", "removed"]);

/** One member row in the §2.2 listing. */
export const memberSchema = z.object({
  userId: idSchema,
  displayName: z.string(),
  emailMasked: maskedContactSchema,
  role: memberRoleSchema,
  status: memberStatusSchema,
  joinedAt: isoDateTimeSchema,
  invitedByUserId: idSchema.nullable(),
  avatarUrl: z.string().nullable(),
});

/** The `GET /api/v1/tenants/{tenantId}/members` body (§2.2). */
export const memberListSchema = z.object({ data: z.array(memberSchema) });

/** The `PATCH /api/v1/tenants/{tenantId}/members/{userId}` result body (§2.2). */
export const memberMutationSchema = z.object({
  userId: idSchema,
  role: memberRoleSchema,
});

/** A projected member. */
export type Member = z.infer<typeof memberSchema>;
