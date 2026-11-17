import { ObjectId } from "mongodb";

import { maskEmail, maskPhone } from "@openpic/contracts";

import { getAuth } from "@/server/auth";
import { resolvePrincipal } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { inviteeEmail, storedInvitee } from "./invitation-access";
import { hexId, maskInvitee, type InvitationDecisionBody } from "./invitation-dto";
import { matchInvitee, type InviteeAccount, type InviteeContact } from "./invitee-identity";
import { invitationByTokenFilter } from "./invitations";
import {
  decideInvitation,
  type DecisionChannel,
  type DecisionInvitationRow,
  type InvitationDecision,
} from "./invitation-transition";

/**
 * The two invitation-decision paths (OP-121, contract §2.3, schema §13.6).
 *
 * Both paths answer the same question and delegate the transition to
 * {@link decideInvitation}; they differ only in how they name the invitation
 * and the caller:
 *
 * - **in-app** — `POST /me/invitations/{invitationId}/{accept|reject}`: a
 *   `user` session names the caller, `resolvedVia: "in_app"`.
 * - **token** — `POST /invitations/{token}/{accept|reject}`: the raw link token
 *   names the invitation (looked up by its sha256), the session names the
 *   caller, and `resolvedVia` is `?via=sms` or `email`. An unauthenticated
 *   caller is `401 authentication_required` carrying `loginUrl` and the masked
 *   invitee — the token is never consumed.
 *
 * A known invitation addressed to someone else is `403 invitation_not_for_you`
 * on both paths (never `404`, which names no row), and a matching but unverified
 * contact is the shipped `403 account_incomplete` (ADR-0665 I-A2).
 */

/** The Better Auth-owned user collection (schema §13.1). */
const USER_COLLECTION = "user";

/** Where a signed-out invitee signs in before returning to the same link. */
const SIGN_IN_PATH = "/sign-in";

/**
 * Read the invitation id from the decision request's path.
 *
 * The id sits one segment before the `{accept|reject}` verb.
 *
 * @param request - The inbound request.
 * @returns The invitation id.
 * @throws {AppError} `not_found` when the segment is not a 24-hex id.
 */
function invitationIdFromRequest(request: Request): ObjectId {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = String(segments.at(-2));
  if (!/^[0-9a-f]{24}$/i.test(raw)) {
    throw appError("not_found");
  }
  return new ObjectId(raw);
}

/**
 * Read the raw invitation token from the decision request's path.
 *
 * @param request - The inbound request.
 * @returns The token (the segment before the verb).
 * @throws {AppError} `not_found` when the segment is empty.
 */
function tokenFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const token = segments.at(-2) ?? "";
  if (token.length === 0) {
    throw appError("not_found");
  }
  return token;
}

/**
 * The caller's account as {@link matchInvitee} reads it.
 *
 * @param userId - The caller's Better Auth user id.
 * @returns The account's contacts and their verification flags.
 */
async function accountOf(userId: string): Promise<InviteeAccount> {
  const user = (await platformRepo(getDb())
    .collection(USER_COLLECTION)
    .findOne({ _id: new ObjectId(userId) })) as Record<string, unknown> | null;

  return {
    userId,
    email: typeof user?.email === "string" ? user.email : null,
    phoneE164: typeof user?.phoneNumber === "string" ? user.phoneNumber : null,
    emailVerified: user?.emailVerified === true,
    phoneNumberVerified: user?.phoneNumberVerified === true,
  };
}

/**
 * Answer the authorization question both paths ask before they resolve anything.
 *
 * @param invitee - The invitation's stored invitee.
 * @param account - The caller's account.
 * @param masked - The §0.13 masked invitee the refusal carries.
 * @returns Nothing; the transition may proceed.
 * @throws `403 invitation_not_for_you` for a non-invitee and `403
 *   account_incomplete` for an unverified matching contact.
 */
function requireInvitee(invitee: InviteeContact, account: InviteeAccount, masked: string): void {
  const match = matchInvitee(invitee, account);
  if (!match.matched) {
    throw appError("invitation_not_for_you", { details: { inviteeMasked: masked } });
  }
  if (!match.contactVerified) {
    throw appError("account_incomplete");
  }
}

/**
 * Load one invitation by id, or deny the uniform `404`.
 *
 * @param invitationId - The invitation's `_id`.
 * @returns The stored row.
 */
async function loadInvitation(invitationId: ObjectId): Promise<DecisionInvitationRow> {
  const row = (await platformRepo(getDb())
    .collection(COLLECTIONS.invitations)
    .findOne({ _id: invitationId })) as DecisionInvitationRow | null;
  if (row === null) {
    throw appError("not_found");
  }
  return row;
}

/**
 * Decide an invitation from the in-app surface.
 *
 * @param userId - The signed-in caller (published by the `user` auth stage).
 * @param request - The inbound request.
 * @param decision - `accept` or `reject`.
 * @returns The §2.3 decision body.
 */
export async function decideInApp(
  userId: string,
  request: Request,
  decision: InvitationDecision
): Promise<InvitationDecisionBody> {
  const db = getDb();
  const invitationId = invitationIdFromRequest(request);
  const row = await loadInvitation(invitationId);
  const invitee = storedInvitee(row.invitee);
  const masked = maskInvitee(invitee, await inviteeEmail(db, invitee));

  requireInvitee(invitee, await accountOf(userId), masked);

  return decideInvitation(
    { db, decision, via: "in_app", userId, now: systemClock.now() },
    invitationId
  );
}

/**
 * The masked invitee a signed-out link visitor may see (§0.13).
 *
 * @param invitee - The invitation's stored invitee.
 * @returns The single-key preview.
 */
function inviteePreview(invitee: ReturnType<typeof storedInvitee>): Record<string, string> {
  return invitee.kind === "phone"
    ? { phoneMasked: maskPhone(invitee.phoneE164) }
    : { emailMasked: maskEmail(invitee.kind === "email" ? invitee.email : "") };
}

/**
 * Decide an invitation from its emailed / texted link.
 *
 * @param request - The inbound request.
 * @param decision - `accept` or `reject`.
 * @returns The §2.3 decision body.
 */
export async function decideByToken(
  request: Request,
  decision: InvitationDecision
): Promise<InvitationDecisionBody> {
  const db = getDb();
  const token = tokenFromRequest(request);
  const row = (await platformRepo(db)
    .collection(COLLECTIONS.invitations)
    .findOne(invitationByTokenFilter(token))) as DecisionInvitationRow | null;
  if (row === null) {
    throw appError("not_found");
  }

  const invitee = storedInvitee(row.invitee);
  const principal = await resolvePrincipal(request, { auth: getAuth(), database: db });
  if (principal?.kind !== "user") {
    // The token is *not* consumed: the invitee signs in (or up) and returns to
    // the same link. `next` keeps the token out of the body only — the URL is
    // the contract's own affordance (§2.3).
    throw appError("authentication_required", {
      message: "Sign in to accept this invitation.",
      details: {
        loginUrl: `${SIGN_IN_PATH}?next=${encodeURIComponent(`/invite/${token}/${decision}`)}`,
        inviteePreview: inviteePreview(invitee),
      },
    });
  }

  const masked = maskInvitee(invitee, await inviteeEmail(db, invitee));
  requireInvitee(invitee, await accountOf(principal.userId), masked);

  const via: DecisionChannel =
    new URL(request.url).searchParams.get("via") === "sms" ? "sms" : "email";

  return decideInvitation(
    { db, decision, via, userId: principal.userId, now: systemClock.now() },
    new ObjectId(hexId(row._id))
  );
}
