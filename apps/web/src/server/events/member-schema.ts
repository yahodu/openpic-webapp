import { z } from "zod";

import { idSchema, isoDateTimeSchema, maskedContactSchema } from "@openpic/contracts";

/**
 * The event-member DTO (OP-119, contract §4.3, schema §15.2).
 *
 * `GET /api/v1/tenants/{tenantId}/events/{eventId}/members` returns
 * `{ data: EventMember[] }` and the member shape is exactly §4.3's: the display
 * name plus a §0.13 **masked** contact (`emailMasked`). There is no raw
 * `email`/`phone` field on the wire (§0.15): the contact is masked at the
 * projection boundary and `serializeResponse` validates strictly, so a
 * projection that carried the full address would fail rather than leak.
 *
 * The optional `invitationId` §4.3 shows on a co-organizer row is **omitted**:
 * event invitations are §2.3's concern and no row in this read carries one yet
 * (ADR-0640 §A12 leaves it open either way).
 */

/** An event role (schema §15.2). */
export const eventMemberRoleSchema = z.enum(["organizer", "co_organizer"]);

/** An event membership's lifecycle status (schema §15.2). */
export const eventMemberStatusSchema = z.enum(["active", "removed"]);

/** One event member row in the §4.3 listing. */
export const eventMemberSchema = z.object({
  userId: idSchema,
  displayName: z.string(),
  role: eventMemberRoleSchema,
  status: eventMemberStatusSchema,
  emailMasked: maskedContactSchema,
  addedAt: isoDateTimeSchema,
  uploadedImageCount: z.number().int().min(0),
});

/** The `GET …/events/{eventId}/members` body (§4.3). */
export const eventMemberListSchema = z.object({ data: z.array(eventMemberSchema) });

/** A projected event member. */
export type EventMember = z.infer<typeof eventMemberSchema>;
