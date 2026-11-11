import { ObjectId } from "mongodb";
import { z } from "zod";

import {
  idSchema,
  isoDateTimeSchema,
  maskEmail,
  maskPhone,
  maskedContactSchema,
} from "@openpic/contracts";

import type { NormalizedInvitee } from "./invitations";

/**
 * The co-organizer invitation wire shapes (OP-120, contract §2.3, schema
 * §13.6).
 *
 * Three projections exist and each is a **closed** set of keys, serialized
 * strictly by the route pipeline:
 *
 * - {@link invitationBodySchema} — the nine facts §2.3's `201` (and the revoke
 *   `200`) carries. There is deliberately no `token`/`tokenHash`/`invitee` key:
 *   the raw token lives only inside the rendered link, the hash never leaves the
 *   server, and the invitee is projected as a §0.13 masked contact.
 * - {@link invitationListSchema} — `{ data }`, newest first (§2.3).
 * - {@link invitationPreviewSchema} — the five public facts the landing page
 *   needs (assumption A8): no ids, no tenant, no token, no contact.
 *
 * The row this module maps is the stored `invitations` document; a row that
 * does not fit the shape fails loudly rather than projecting a half-filled
 * body, because a silently missing `inviteeMasked` would reach a client as
 * `undefined`.
 */

/** The invitation discriminator every co-organizer invite carries (§13.6). */
export const EVENT_CO_ORGANIZER_KIND = "event_co_organizer";

/** The role granted on acceptance (§2.3). */
export const CO_ORGANIZER_ROLE = "co_organizer";

/** The invitation lifecycle (§13.6) — `status` is the single source of truth. */
export const invitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "revoked",
  "expired",
]);

/** The channel vocabulary an invitation may be carried over (§4.6). */
export const invitationChannelSchema = z.enum(["in_app", "email", "sms"]);

/** One invitation on the wire (§2.3 `201` / revoke `200`). */
export const invitationBodySchema = z.object({
  id: idSchema,
  kind: z.literal(EVENT_CO_ORGANIZER_KIND),
  eventId: idSchema,
  role: z.literal(CO_ORGANIZER_ROLE),
  status: invitationStatusSchema,
  inviteeMasked: maskedContactSchema,
  channelsNotified: z.array(invitationChannelSchema).min(1),
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});

/** The `GET …/invitations` body (§2.3). */
export const invitationListSchema = z.object({ data: z.array(invitationBodySchema) });

/** The public `GET /invitations/{token}` body (assumption A8). */
export const invitationPreviewSchema = z.object({
  status: invitationStatusSchema,
  eventName: z.string(),
  inviterDisplayName: z.string(),
  expiresAt: isoDateTimeSchema,
  inviteeMasked: maskedContactSchema,
});

/** A projected invitation body. */
export type InvitationBody = z.infer<typeof invitationBodySchema>;

/** A projected public preview. */
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/** The stored `invitations` fields the projections read (schema §13.6). */
export interface InvitationRow {
  readonly _id: ObjectId | string;
  readonly kind?: unknown;
  readonly eventId?: unknown;
  readonly role?: unknown;
  readonly status?: unknown;
  readonly invitee?: unknown;
  readonly channelsNotified?: unknown;
  readonly expiresAt?: unknown;
  readonly createdAt?: unknown;
}

/**
 * Read a stored id as 24 lowercase hex characters.
 *
 * The write path stores an `ObjectId` for `eventId` and the repository scope
 * stamps `tenantId` as a hex string, so a projection has to accept both.
 *
 * @param value - The stored id.
 * @returns The hex string.
 */
export function hexId(value: unknown): string {
  if (value instanceof ObjectId) return value.toHexString();
  return String(value);
}

/**
 * Read a stored instant as a `Date`.
 *
 * @param value - The stored value (a driver `Date`, or an ISO string).
 * @returns The instant.
 */
export function instantOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Project an invitee as a §0.13 masked contact.
 *
 * An email keeps its first character and domain, a phone its country code and
 * last four digits. A `user` invitee has no contact on the row, so the caller
 * supplies the account's email when it has one; without one the whole value is
 * masked, which is the `maskEmail` degradation path — never the raw address.
 *
 * @param invitee - The normalized invitee stored on the row.
 * @param accountEmail - The invitee account's email, when it could be resolved.
 * @returns The masked contact.
 */
export function maskInvitee(
  invitee: NormalizedInvitee,
  accountEmail: string | null = null
): string {
  switch (invitee.kind) {
    case "email":
      return maskEmail(invitee.email);
    case "phone":
      return maskPhone(invitee.phoneE164);
    case "user":
      return maskEmail(accountEmail ?? "");
  }
}

/**
 * Project one stored invitation onto the §2.3 body.
 *
 * @param row - The stored `invitations` document.
 * @param invitee - Its normalized invitee.
 * @param accountEmail - The invitee account's email, for a `user` invitee.
 * @returns The validated body (exactly nine keys).
 * @throws When the row does not fit the projection (a corrupt document must
 *   never reach a client as a half-filled body).
 */
export function toInvitationBody(
  row: InvitationRow,
  invitee: NormalizedInvitee,
  accountEmail: string | null = null
): InvitationBody {
  return invitationBodySchema.parse({
    id: hexId(row._id),
    kind: row.kind,
    eventId: hexId(row.eventId),
    role: row.role,
    status: row.status,
    inviteeMasked: maskInvitee(invitee, accountEmail),
    channelsNotified: row.channelsNotified,
    expiresAt: instantOf(row.expiresAt).toISOString(),
    createdAt: instantOf(row.createdAt).toISOString(),
  });
}
