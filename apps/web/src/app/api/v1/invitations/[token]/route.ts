import { ObjectId } from "mongodb";

import {
  invitationPreviewSchema,
  type InvitationPreview,
  type InvitationRow,
} from "@/server/collaboration/invitation-dto";
import { projectInvitationPreview } from "@/server/collaboration/invitation-access";
import { invitationByTokenFilter } from "@/server/collaboration/invitations";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";

/**
 * `GET /api/v1/invitations/{token}` — the public invitation preview (OP-120,
 * contract §2.3, schema §13.6; ADR-0661).
 *
 * The invitee opens the link from their email/SMS before they have an account,
 * so this route is **public**: no session stage, because the redeemable token
 * *is* the credential and the landing page must render for a signed-out visitor.
 *
 * The token is never a query value: the raw path segment is hashed
 * (`invitationByTokenFilter`) and the row is read by its `tokenHash`. An
 * unknown, malformed or never-issued token therefore matches nothing and answers
 * the single non-oracle failure shape `404 not_found` — a visitor cannot tell a
 * revoked invite from one that never existed.
 *
 * The body carries the five facts a landing page needs (assumption A8:
 * `status`, `eventName`, `inviterDisplayName`, `expiresAt`, `inviteeMasked`) and
 * nothing that would let a visitor enumerate the collaboration graph: no ids,
 * no tenant, no token, no raw contact.
 *
 * The 20/min per-IP budget §2.3 specifies is a deployment concern owned by the
 * rate-limit stage and is not part of this story's pins.
 */

/** The invitation row fields the preview reads. */
interface PreviewRow extends InvitationRow {
  readonly tenantId?: unknown;
  readonly invitedByUserId?: unknown;
}

/** The `events` fields the preview reads. */
interface EventRow {
  readonly name?: unknown;
}

/** The `userProfiles` fields the preview reads (schema §13.2). */
interface ProfileRow {
  readonly displayName?: unknown;
}

/**
 * The `{token}` path segment of this request.
 *
 * @param request - The inbound request.
 * @returns The raw token.
 * @throws {AppError} `not_found` when the segment is empty — an empty token
 *   cannot redeem anything.
 */
function tokenFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const token = String(segments.at(-1));
  if (token.length === 0) {
    throw appError("not_found");
  }
  return token;
}

export const GET = defineRoute({
  route: "/api/v1/invitations/:token",
  response: invitationPreviewSchema,
  handler: async (ctx): Promise<{ body: InvitationPreview; headers: Record<string, string> }> => {
    const db = getDb();
    const token = tokenFromRequest(ctx.request);

    const row = (await platformRepo(db)
      .collection(COLLECTIONS.invitations)
      .findOne(invitationByTokenFilter(token))) as PreviewRow | null;
    if (row === null) {
      throw appError("not_found");
    }

    // The event and the inviter are read tenant-scoped: an invitation whose
    // event has already been purged is no longer previewable.
    const event = (await platformRepo(db)
      .collection(COLLECTIONS.events)
      .findOne({
        _id: row.eventId as ObjectId,
        tenantId: String(row.tenantId),
      })) as EventRow | null;
    if (event === null) {
      throw appError("not_found");
    }

    const profile = (await platformRepo(db)
      .collection(COLLECTIONS.userProfiles)
      .findOne({ userId: row.invitedByUserId })) as ProfileRow | null;

    return {
      body: await projectInvitationPreview(
        db,
        row,
        typeof event.name === "string" ? event.name : "",
        typeof profile?.displayName === "string" ? profile.displayName : ""
      ),
      headers: {},
    };
  },
});
