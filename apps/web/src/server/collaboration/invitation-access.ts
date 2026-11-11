import { ObjectId, type Db } from "mongodb";

import { platformRepo } from "@/server/repos";

import {
  toInvitationBody,
  type InvitationBody,
  type InvitationRow,
  type InvitationPreview,
  instantOf,
  maskInvitee,
} from "./invitation-dto";
import { normalizeInvitee, type NormalizedInvitee } from "./invitations";

/**
 * The invitation read projections (OP-120, contract §2.3, schema §13.6).
 *
 * An invitation stores only its canonical invitee (`{kind, userId|email|
 * phoneE164}`) and never a display contact — that is the point of the lazy
 * invite. Every read that has to show a §0.13 masked contact therefore resolves
 * the contact the same way: the stored address for an `email`/`phone` invite,
 * and the account's own email for a `user` invite (looked up through the Better
 * Auth `user` collection, the same document the event-member listing reads).
 *
 * Keeping this in one place means the `201`, the list, the revoke `200` and the
 * public preview can never disagree about what a masked invitee is, and no read
 * path has a reason to reach for the raw address.
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** The Better Auth user fields this module reads. */
interface UserDocument {
  readonly email?: unknown;
}

/** The Better Auth user id, for the membership lookup. */
interface UserIdDocument {
  readonly _id?: unknown;
}

/**
 * Read the canonical invitee stored on an invitation row.
 *
 * The row was written through {@link normalizeInvitee}, so a row that no longer
 * normalizes is corrupt data, not a client error — it throws rather than
 * projecting an empty mask.
 *
 * @param value - The stored `invitee` subdocument.
 * @returns The canonical invitee.
 * @throws When the stored subdocument is not a valid invitee.
 */
export function storedInvitee(value: unknown): NormalizedInvitee {
  const input = typeof value === "object" && value !== null ? value : {};
  const record = input as Record<string, unknown>;
  const result = normalizeInvitee({
    kind: typeof record.kind === "string" ? record.kind : "",
    userId: typeof record.userId === "string" ? record.userId : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    phoneE164: typeof record.phoneE164 === "string" ? record.phoneE164 : undefined,
  });
  if (!result.ok) {
    throw new Error(`stored invitation invitee is not canonical: ${result.code}`);
  }
  return result.invitee;
}

/**
 * Resolve the account email behind a canonical invitee.
 *
 * An `email` invitee *is* the address; a `phone` invitee has none stored; a
 * `user` invitee's address comes from the Better Auth `user` document.
 *
 * @param db - The database handle.
 * @param invitee - The canonical invitee.
 * @returns The address, or `null` when the invitee has none (account-less
 *   phone invitee, or an unknown user document).
 */
export async function inviteeEmail(db: Db, invitee: NormalizedInvitee): Promise<string | null> {
  switch (invitee.kind) {
    case "email":
      return invitee.email;
    case "phone":
      return null;
    case "user": {
      const user = (await platformRepo(db)
        .collection(USER_COLLECTION)
        .findOne({ _id: new ObjectId(invitee.userId) })) as UserDocument | null;
      return typeof user?.email === "string" ? user.email : null;
    }
  }
}

/**
 * The caller's own email, for the self-invitation refusal.
 *
 * @param db - The database handle.
 * @param userId - The caller's Better Auth user id (hex string).
 * @returns The account's lowercase email, or `null` when absent.
 */
export async function callerEmail(db: Db, userId: string): Promise<string | null> {
  const user = (await platformRepo(db)
    .collection(USER_COLLECTION)
    .findOne({ _id: new ObjectId(userId) })) as UserDocument | null;
  return typeof user?.email === "string" ? user.email.toLowerCase() : null;
}

/**
 * Resolve the account id behind a canonical invitee.
 *
 * An invitation may precede the account, so an `email`/`phone` invitee is
 * looked up in the Better Auth `user` document; no match means the invitee has
 * no account yet and therefore no membership row to collide with.
 *
 * @param db - The database handle.
 * @param invitee - The canonical invitee.
 * @param accountEmail - The invitee's address when one was resolved.
 * @returns The account id (hex string), or `null` for an account-less invitee.
 */
export async function resolveInviteeUserId(
  db: Db,
  invitee: NormalizedInvitee,
  accountEmail: string | null
): Promise<string | null> {
  const collection = platformRepo(db).collection(USER_COLLECTION);

  let user: UserIdDocument | null;
  switch (invitee.kind) {
    case "user":
      return invitee.userId;
    case "email":
      if (accountEmail === null) return null;
      user = (await collection.findOne({ email: accountEmail })) as UserIdDocument | null;
      break;
    case "phone":
      user = (await collection.findOne({
        phoneNumber: invitee.phoneE164,
      })) as UserIdDocument | null;
      break;
  }

  return user?._id instanceof ObjectId ? user._id.toHexString() : null;
}

/**
 * Project one stored invitation onto the §2.3 body.
 *
 * @param db - The database handle (used for a `user` invitee's contact).
 * @param row - The stored `invitations` document.
 * @returns The validated nine-key body.
 */
export async function projectInvitation(db: Db, row: InvitationRow): Promise<InvitationBody> {
  const invitee = storedInvitee(row.invitee);
  return toInvitationBody(row, invitee, await inviteeEmail(db, invitee));
}

/**
 * Project one stored invitation onto the public preview body (assumption A8).
 *
 * The preview carries the five facts a landing page shows and nothing that
 * would let a visitor enumerate the event's collaboration graph: no ids, no
 * tenant, no token, no raw contact.
 *
 * @param db - The database handle.
 * @param row - The stored `invitations` document.
 * @param eventName - The event's name.
 * @param inviterDisplayName - The inviting organizer's display name.
 * @returns The validated five-key preview.
 */
export async function projectInvitationPreview(
  db: Db,
  row: InvitationRow,
  eventName: string,
  inviterDisplayName: string
): Promise<InvitationPreview> {
  const invitee = storedInvitee(row.invitee);
  return {
    status: row.status as InvitationPreview["status"],
    eventName,
    inviterDisplayName,
    expiresAt: instantOf(row.expiresAt).toISOString(),
    inviteeMasked: maskInvitee(invitee, await inviteeEmail(db, invitee)),
  };
}
